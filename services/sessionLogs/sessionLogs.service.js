import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// Must match the JWT lifetime in utils/jwt/jwt.util.js ("8h"). Kept as its
// own constant here (rather than importing jsonwebtoken just to read the
// option back out) since this is only used to know when an unclosed
// session should be considered stale.
const TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000;

// ── CREATE (successful login) ────────────────────────────────────────────
// Opens a new sessionLogs doc. `platform` is hardcoded by the caller
// (auth.controller.js here always passes "admin_web") — never inferred,
// since role alone doesn't tell you which physical app a login came from.
export const createSessionLog = async ({ uID, username, platform }) => {
  const ref = db.collection("sessionLogs").doc();
  await ref.set({
    sessionLogsID: ref.id,
    uID,
    username: username || "",
    platform: platform || "unknown",
    status: "active",
    closedReason: null,
    loginDateTime: admin.firestore.FieldValue.serverTimestamp(),
    logoutDateTime: null,
    sessionDuration: 0,
    attemptedAt: null,
    blockedReason: "",
  });
  return ref.id;
};

// ── CLOSE (explicit logout — manual or forced/revoked) ──────────────────
// closedReason: "manual" (user clicked Log out) or "revoked" (an admin
// locked/deleted/changed the role of this account while they were still
// logged in — see AuthContext.jsx's real-time listener on the frontend).
export const closeSessionLog = async (sessionLogsID, closedReason = "manual") => {
  if (!sessionLogsID) return;

  const logRef = db.collection("sessionLogs").doc(sessionLogsID);
  const logDoc = await logRef.get();
  if (!logDoc.exists) return; // e.g. already archived — never block logout on this

  const data = logDoc.data();
  const loginDateTime = data.loginDateTime?.toDate
    ? data.loginDateTime.toDate()
    : new Date(data.loginDateTime);

  const now = new Date();
  const sessionDuration = Math.max(
    0,
    Math.round((now.getTime() - loginDateTime.getTime()) / 1000)
  );

  await logRef.update({
    status: "logged_out",
    closedReason,
    logoutDateTime: admin.firestore.FieldValue.serverTimestamp(),
    sessionDuration,
  });
};

// ── BLOCKED LOGIN ATTEMPT ────────────────────────────────────────────────
// No session ever opens for a failed login (account locked/inactive), so
// this writes a standalone row instead — same collection, so Session Logs
// stays the single place to see all login activity, successful or not.
export const recordBlockedAttempt = async ({ uID, username, platform, blockedReason }) => {
  const ref = db.collection("sessionLogs").doc();
  await ref.set({
    sessionLogsID: ref.id,
    uID: uID || null,
    username: username || "",
    platform: platform || "unknown",
    status: "blocked",
    closedReason: null,
    loginDateTime: null,
    logoutDateTime: null,
    sessionDuration: 0,
    attemptedAt: admin.firestore.FieldValue.serverTimestamp(),
    blockedReason: blockedReason || "",
  });
  return ref.id;
};

// ── LAZY EXPIRY CHECK (run at the start of every login) ─────────────────
// Finds any of THIS account's sessions still marked "active" whose token
// would already have expired, and flips them to "expired". Handles the
// common "closed the tab without logging out" case the moment the person
// comes back — checks ALL open sessions for the uID, not just the latest,
// since multiple devices can be logged in at once (no single-session
// enforcement in this app).
export const expireStaleSessionsForUser = async (uID) => {
  if (!uID) return;

  const cutoff = new Date(Date.now() - TOKEN_LIFETIME_MS);
  const snap = await db
    .collection("sessionLogs")
    .where("uID", "==", uID)
    .where("status", "==", "active")
    .get();

  const batch = db.batch();
  let count = 0;

  snap.docs.forEach((doc) => {
    const loginDateTime = doc.data().loginDateTime?.toDate
      ? doc.data().loginDateTime.toDate()
      : new Date(doc.data().loginDateTime);

    if (loginDateTime < cutoff) {
      batch.update(doc.ref, { status: "expired" });
      count++;
    }
  });

  if (count > 0) await batch.commit();
  return count;
};

// ── SCHEDULED SWEEP (nightly cron) ───────────────────────────────────────
// Backstop for accounts that never come back to trigger the lazy check
// above — otherwise an abandoned session from someone who never logs in
// again would sit marked "active" forever.
export const sweepExpiredSessions = async () => {
  const cutoff = new Date(Date.now() - TOKEN_LIFETIME_MS);
  const snap = await db
    .collection("sessionLogs")
    .where("status", "==", "active")
    .get();

  const batch = db.batch();
  let count = 0;

  snap.docs.forEach((doc) => {
    const loginDateTime = doc.data().loginDateTime?.toDate
      ? doc.data().loginDateTime.toDate()
      : new Date(doc.data().loginDateTime);

    if (loginDateTime < cutoff) {
      batch.update(doc.ref, { status: "expired" });
      count++;
    }
  });

  if (count > 0) await batch.commit();
  return count;
};

// ── READ ──────────────────────────────────────────────────────────────────
export const getAllSessionLogs = async () => {
  // No single timestamp field is guaranteed on every row (blocked-attempt
  // rows have no loginDateTime), so fetch plainly and sort client-side
  // below using whichever timestamp each row actually has.
  const snapshot = await db.collection("sessionLogs").get();

  const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

  return snapshot.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        loginDateTime: toISO(data.loginDateTime),
        logoutDateTime: toISO(data.logoutDateTime),
        attemptedAt: toISO(data.attemptedAt),
      };
    })
    .sort((a, b) => {
      const aTime = new Date(a.loginDateTime || a.attemptedAt || 0).getTime();
      const bTime = new Date(b.loginDateTime || b.attemptedAt || 0).getTime();
      return bTime - aTime;
    });
};

export const getAllSessionLogsArchive = async () => {
  const snapshot = await db
    .collection("sessionLogArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      loginDateTime: toISO(data.loginDateTime),
      logoutDateTime: toISO(data.logoutDateTime),
      attemptedAt: toISO(data.attemptedAt),
      archivedAt: toISO(data.archivedAt),
    };
  });
};

export const archiveSessionLog = async (id) => {
  const logRef = db.collection("sessionLogs").doc(id);
  const logDoc = await logRef.get();

  if (!logDoc.exists) throw new Error("Session log not found.");

  const logData = logDoc.data();

  await db.collection("sessionLogArchives").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};