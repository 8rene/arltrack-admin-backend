// All Firestore reads/writes for bookingSessions live here — same
// convention as your other services/ files. The plain data shape this
// operates on is in models/bookingSession/bookingsession.model.js.
//
// Query helpers exist because Firestore has no joins — these resolve
// "which session is active for this car right now" without one:
//
//   getActiveSessionByCar / getAllActiveSessions — read by carID / sessionStatus
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
    .where("sessionStatus", "==", "active")
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { ref: doc.ref, data: doc.data() };
};

/** All sessions currently active — this is what the nightly cron iterates. */
export const getAllActiveSessions = async () => {
  const snap = await SESSIONS().where("sessionStatus", "==", "active").get();
  return snap.docs.map((doc) => ({ ref: doc.ref, data: doc.data() }));
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
    sessionStatus: "active",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

export const markSessionCancelled = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    sessionStatus: "cancelled",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/** Mark a session ended — call at return/cancel. Leaves carID as history. */
export const markSessionEnded = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    sessionStatus: "ended",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

/** Flag a session stolen — call from the Car Tracking "Stolen" button. Manual only, no auto-trigger. */
export const markSessionStolen = async (bookingSessionID) => {
  await SESSIONS().doc(bookingSessionID).update({
    sessionStatus: "stolen",
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