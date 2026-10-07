// All Firestore reads/writes for bookingSessions live here — same
// convention as your other services/ files. The plain data shape this
// operates on is in models/bookingSession/bookingsession.model.js.
//
// Query helpers exist because Firestore has no joins — these resolve
// "which session is active for this car right now" without one:
//
//   getActiveSessionByCar / getAllActiveSessions — read by carID / status
//   getSessionById / getSessionByBookingID        — direct + FK lookups
//   markSessionActive / markSessionEnded / markSessionStolen — status writes,
//     called from wherever pickup / return / stolen actually happen
//   recordArchiveFlush — called by flushBookingHistory (now in
//     booking.service.js) after a successful Storage upload

import { db, bucket } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { sessionStartedAt, queryRecentByStart } from "../../utils/date/sessionDates.js";

const SESSIONS = () => db.collection("bookingSessions");

/**
 * Find the one active session for a given car, if any.
 * Returns { ref, data } or null.
 */
export const getActiveSessionByCar = async (carID) => {
  const snap = await SESSIONS()
    .where("carID", "==", carID)
    .where("status", "==", "active")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { ref: doc.ref, data: doc.data() };
};

// ── Live-ping variant: remembers "this car has NO active session" briefly ────
// A parked car pings every few seconds and each ping would otherwise run this
// query just to learn "nothing to do". Only the negative answer is cached (an
// active session is always re-read so its alert state is never stale), and
// markSessionActive clears it on the same instance so a trip start isn't missed.
const NO_ACTIVE_TTL_MS = 15_000;
const noActiveUntil = new Map(); // carID -> expiry ms
export const getActiveSessionByCarCached = async (carID) => {
  const until = noActiveUntil.get(carID);
  if (until && Date.now() < until) return null;
  const session = await getActiveSessionByCar(carID);
  if (!session) noActiveUntil.set(carID, Date.now() + NO_ACTIVE_TTL_MS);
  else noActiveUntil.delete(carID);
  return session;
};

/** All sessions currently active — this is what the nightly cron iterates. */
export const getAllActiveSessions = async () => {
  const snap = await SESSIONS().where("status", "==", "active").get();
  return snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }));
};

/**
 * Every session (any status — active, ended, stolen, cancelled) ever tied to
 * a car, most recent first. Used by Car Tracking's Traceback (find which
 * session(s) cover a given date) and History (list every archived trip) —
 * neither cares about a car's CURRENT session, they need the full history.
 * Sorted in memory (not orderBy) for the same reason getAllGpsDevices does:
 * a composite index would otherwise be required for carID-equality +
 * startedAt-order. Ordered by the real start (see utils/date/sessionDates.js
 * for the legacy fallback); sessions that never started sort last.
 */
export const getSessionsByCar = async (carID) => {
  const snap = await SESSIONS().where("carID", "==", carID).get();
  const sessions = snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }));
  sessions.sort((a, b) => {
    const at = sessionStartedAt(a.data)?.getTime() ?? 0;
    const bt = sessionStartedAt(b.data)?.getTime() ?? 0;
    return bt - at;
  });
  return sessions;
};

/**
 * Traceback only needs the session around ONE date, not the car's whole
 * history. Newest few sessions that started on/before the end of that date
 * (a car's trips don't overlap, so the match is among them). Needs a
 * composite index (carID asc, startedAt desc) — if it's missing, or this
 * returns nothing, callers fall back to the full getSessionsByCar read.
 */
export const getRecentSessionsByCarUpTo = (carID, endOfDate, limit = 4) =>
  queryRecentByStart(SESSIONS(), carID, endOfDate, limit);

/** Look a session up directly by its own primary key. */
export const getSessionById = async (bookingSessionID) => {
  const doc = await SESSIONS().doc(bookingSessionID).get();
  return doc.exists ? { ref: doc.ref, data: doc.data() } : null;
};

/**
 * Move a booking's destination geofence zone to new coordinates.
 *
 * The customer backend writes geofenceZones as [Pickup, <destination>, ...extra
 * stops], with the destination zone labelled by the destination text (the same
 * text stored on bookings.location). So the zone is found by its old label, falling
 * back to slot 1 when slot 0 is the "Pickup" zone. If neither matches, the zone is
 * appended instead — a destination edit never overwrites a pickup/extra-stop zone.
 * Keeps the zone's existing radius. Returns false when the booking has no session.
 */
export const updateSessionDestination = async (bookingID, oldLabel, { address, lat, lng }) => {
  const session = await getSessionByBookingID(bookingID);
  if (!session) return false;

  const zones = Array.isArray(session.data.geofenceZones) ? [...session.data.geofenceZones] : [];
  const norm = (s) => (s || "").trim().toLowerCase();

  let idx = norm(oldLabel) && norm(oldLabel) !== "pickup"
    ? zones.findIndex((z) => z && norm(z.label) === norm(oldLabel))
    : -1;
  if (idx === -1 && zones.length >= 2 && norm(zones[0]?.label) === "pickup") idx = 1;

  const radius = zones[idx]?.radius ?? zones[0]?.radius ?? 500;
  const next = { label: address, lat, lng, radius };
  if (idx === -1) zones.push(next); else zones[idx] = next;

  await session.ref.update({ geofenceZones: zones });
  return true;
};

/** Look a session up by the bookingID FK — used when a booking's status changes. */
export const getSessionByBookingID = async (bookingID) => {
  const snap = await SESSIONS().where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { ref: doc.ref, data: doc.data() };
};

/**
 * Mark a session active and attach it to a car — call this at pickup.
 * bookingID is the FK already on the doc; carID is what's new here.
 *
 * Also auto-copies the car's standing default geofence zones (see
 * gps.controller.js's getCarGeofenceDefaults/cars/{carID}.defaultGeofenceZones)
 * onto this session's own geofenceZones — but only if the session doesn't
 * already have zones of its own (e.g. set up ahead of pickup via Booking
 * Info's active-trip editor before this ran). Best-effort: a failure here
 * must never block pickup itself, same reasoning as booking.service.js's
 * caller already applies around this whole call.
 */
export const markSessionActive = async (bookingSessionID, carID) => {
  noActiveUntil.delete(carID);
  const sessionRef = SESSIONS().doc(bookingSessionID);
  const updates = {
    carID,
    status: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const sessionDoc = await sessionRef.get();
    // Stamp the ACTUAL pickup moment once. The scheduled dates live on the
    // booking (startDateTime/endDateTime), not here; Traceback and the history
    // flush need the real start so an early pickup doesn't look at the wrong
    // Sheets date-tabs and come back empty. A pre-migration doc may already
    // hold it as activatedAt — carry that over instead of overwriting it.
    const existing = sessionDoc.exists ? sessionDoc.data() : {};
    if (!existing.startedAt) {
      updates.startedAt = existing.activatedAt || admin.firestore.FieldValue.serverTimestamp();
    }
    const existingZones = sessionDoc.exists ? (sessionDoc.data().geofenceZones || []) : [];
    if (existingZones.length === 0) {
      const carDoc = await db.collection("cars").doc(carID).get();
      const defaultZones = carDoc.exists ? (carDoc.data().defaultGeofenceZones || []) : [];
      if (defaultZones.length > 0) {
        updates.geofenceZones = defaultZones;
      }
    }
  } catch (err) {
    console.error("[BookingSession] Failed to copy default zones onto session (non-fatal, session still activated):", err.message);
  }

  await sessionRef.update(updates);
};

export const markSessionCancelled = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    status: "cancelled",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/** Mark a session ended — call at return/cancel. Leaves carID as history. */
export const markSessionEnded = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    status: "ended",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/** Flag a session stolen — call from the Car Tracking "Stolen" button. Manual only, no auto-trigger. */
export const markSessionStolen = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    status: "stolen",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/**
 * Universal marker, every booking type: the vehicle itself is physically
 * back, as distinct from Return (which only happens once inspection /
 * penalties / device-check all clear). Deliberately doesn't touch
 * `status`; this is purely an extra timestamp alongside startedAt. No backfill, no re-editing — the caller
 * (booking.service.js's markBookingDroppedOff) is responsible for only
 * calling this once, and for checking droppedOffTime isn't already set
 * before calling it.
 */
export const markDroppedOff = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    droppedOffTime: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/**
 * Record the result of a successful archive flush. The archive file was just
 * rewritten, so any saved pointCount is now stale — clear it and let
 * getArchivePointCount below recount lazily the next time History loads.
 */
export const recordArchiveFlush = async (bookingSessionID, archiveUrl) => {
  await SESSIONS().doc(bookingSessionID).update({
    archiveUrl,
    pointCount: admin.firestore.FieldValue.delete(),
    lastArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/**
 * How many GPS points a session's archived trail holds — shown in History
 * before anyone clicks Review. Returns the saved pointCount when there is one;
 * otherwise reads the trip's Storage file once, saves the count on the session
 * and returns it. Returns null if the file can't be read (History then just
 * shows no count for that trip). Takes { ref, data } like the other helpers.
 */
export const getArchivePointCount = async ({ ref, data }) => {
  if (typeof data.pointCount === "number") return data.pointCount;
  if (!data.archiveUrl) return null;
  try {
    const [buf] = await bucket.file(`bookingHistory/${data.bookingSessionID}.json`).download();
    const parsed = JSON.parse(buf.toString("utf8"));
    const n = Array.isArray(parsed) ? parsed.length : (parsed.points?.length ?? 0); // older files are bare arrays
    ref.update({ pointCount: n }).catch(() => {});
    return n;
  } catch (e) {
    console.warn(`[BookingSession] couldn't count points for ${data.bookingSessionID}:`, e.message);
    return null;
  }
};