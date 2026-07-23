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
//   recordArchiveFlush — called by the nightly flush job after a successful
//     Storage upload

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

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
 * pickupTime-order, and older/hand-created docs missing pickupTime would
 * silently vanish from the results.
 */
export const getSessionsByCar = async (carID) => {
  const snap = await SESSIONS().where("carID", "==", carID).get();
  const sessions = snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }));
  sessions.sort((a, b) => {
    const at = a.data.pickupTime?._seconds ?? a.data.pickupTime?.seconds ?? 0;
    const bt = b.data.pickupTime?._seconds ?? b.data.pickupTime?.seconds ?? 0;
    return bt - at;
  });
  return sessions;
};

/** Look a session up directly by its own primary key. */
export const getSessionById = async (bookingSessionID) => {
  const doc = await SESSIONS().doc(bookingSessionID).get();
  return doc.exists ? { ref: doc.ref, data: doc.data() } : null;
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
 */
export const markSessionActive = async (bookingSessionID, carID) => {
  await SESSIONS().doc(bookingSessionID).update({
    carID,
    status: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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

/** Record the result of a successful archive flush. */
export const recordArchiveFlush = async (bookingSessionID, archiveUrl) => {
  await SESSIONS().doc(bookingSessionID).update({
    archiveUrl,
    lastArchivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};