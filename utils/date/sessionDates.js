// Shared helpers for "when did this trip start / end?" on a bookingSession
// (or bookingSessionArchives) doc.
//
// The session no longer stores the SCHEDULED pickupTime/returnTime — those
// live on the booking (startDateTime/endDateTime). A session carries only
// real moments:
//   startedAt      stamped once by markSessionActive (the actual pickup)
//   droppedOffTime set when someone taps "Dropped Off"
//   lastArchivedAt set by every history flush (the Return flush is the last)
//
// LEGACY FALLBACK: until scripts/migrate-session-dates.js has been run, old
// docs still carry activatedAt / pickupTime instead of startedAt. The
// fallbacks below keep them working. After the migration's phase 2 (old
// fields removed) the legacy branches are dead code and can be deleted.

import admin from "firebase-admin";

const STARTED_STATUSES = new Set(["active", "ended", "stolen"]);

export const toDate = (v) => {
  if (!v) return null;
  const d = v.toDate ? v.toDate()
    : v._seconds != null ? new Date(v._seconds * 1000)
    : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

/** Actual start of the trip, or null if it never started. */
export const sessionStartedAt = (data) => {
  if (!data) return null;
  const real = toDate(data.startedAt) || toDate(data.activatedAt); // activatedAt = legacy
  if (real) return real;
  // Legacy docs from before activatedAt existed: scheduled pickup is the only
  // start we have — but only trust it for trips that actually started.
  return STARTED_STATUSES.has(data.status) ? toDate(data.pickupTime) : null;
};

/**
 * Best known end of the trip, or null while it's still going (active/stolen —
 * the car keeps pinging, so callers should treat null as "now").
 * Ended: the latest of droppedOffTime / lastArchivedAt (the Return flush
 * stamps lastArchivedAt right after Return is confirmed).
 */
export const sessionEndedAt = (data) => {
  if (!data || data.status !== "ended") return null;
  const moments = [toDate(data.droppedOffTime), toDate(data.lastArchivedAt)].filter(Boolean);
  if (!moments.length) return null;
  return new Date(Math.max(...moments.map((d) => d.getTime())));
};

/**
 * Newest few sessions of a car that STARTED on/before endOfDate.
 * Needs composite index (carID asc, startedAt desc) on the collection —
 * if it's missing this throws, and callers fall back to their full read.
 * Also queries the legacy pickupTime field (index already exists) so
 * un-migrated docs still turn up; results are merged and re-sorted by the
 * real start. Remove the legacy query after the migration's phase 2.
 */
export const queryRecentByStart = async (colRef, carID, endOfDate, limit = 4) => {
  const ts = admin.firestore.Timestamp.fromDate(endOfDate);
  const run = (field, n) => colRef
    .where("carID", "==", carID)
    .where(field, "<=", ts)
    .orderBy(field, "desc")
    .limit(n)
    .get();

  const [modern, legacy] = await Promise.all([
    run("startedAt", limit),
    run("pickupTime", limit * 2).catch(() => null), // legacy; never block on it
  ]);

  const byId = new Map();
  for (const snap of [modern, legacy]) {
    if (!snap) continue;
    for (const doc of snap.docs) byId.set(doc.id, { ref: doc.ref, data: doc.data() });
  }
  return [...byId.values()]
    .filter((s) => { const st = sessionStartedAt(s.data); return st && st <= endOfDate; })
    .sort((a, b) => sessionStartedAt(b.data) - sessionStartedAt(a.data))
    .slice(0, limit);
};