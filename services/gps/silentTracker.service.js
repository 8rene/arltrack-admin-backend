// Tells staff when a car on an active trip stops reporting its location.
//
// Everything else in the live pipeline is driven by pings, and a dead tracker sends none — so this is the
// one check that has to run on a timer. Vercel's cron plan here only allows daily jobs (see jobs/ and
// vercel.json), so instead of a cron it piggybacks on traffic that already exists: any GPS ping from any
// car, and every poll of the Live map. It is throttled to one run per 5 minutes per server instance, and
// notifications are de-duplicated, so extra runs are harmless. A run costs one query of the active
// sessions (only real trips) plus one of the GPS devices — the last-ping time is already on the session.
//
// Known limit: if EVERY tracker goes quiet and nobody has the Live map open, nothing triggers it.
// POST /api/cron/silent-trackers (cron.routes.js) runs it on demand for an external 5-minute scheduler.

import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { getAllActiveSessions } from "../booking/bookingSession.service.js";
import { notifyStaff, resolveNotification } from "../notification/notification.service.js";
import { findSilentSessions } from "./silentTrackerLogic.js";

const NOTIF_TYPE = "tracker_silent";
const CHECK_EVERY_MS = 5 * 60 * 1000;

let lastRunAt = 0;
let running = false;

const carLabel = async (carID) => {
  try {
    const doc = await db.collection("cars").doc(carID).get();
    const plate = doc.exists ? doc.data().plateNumber : "";
    return plate ? `Car ${plate}` : "A car";
  } catch {
    return "A car";
  }
};

/** One full pass (not throttled). Returns a small summary. */
export const runSilentTrackerCheck = async () => {
  const nowMs = Date.now();
  const sessions = await getAllActiveSessions();

  // Which cars actually have a tracker assigned? A car without one can't be "silent".
  const devSnap = await db.collection("gpsDevice").where("assigned", "==", true).get();
  const assignedCarIDs = new Set(devSnap.docs.map((d) => d.data().carID).filter(Boolean));

  const silent = findSilentSessions(sessions, assignedCarIDs, nowMs);
  for (const s of silent) {
    const mins = Math.floor(s.silentForMs / 60000);
    const label = await carLabel(s.data.carID);
    await notifyStaff({
      type: NOTIF_TYPE,
      refID: s.data.carID,
      refCollection: "cars",
      title: "Tracker not reporting",
      message: `${label} is on an active trip but has sent no location for ${mins} minutes.`,
    });
    // Remember we alerted, so the next sweep doesn't repeat it. Cleared when the next ping arrives.
    await s.ref.update({ silentAlertedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  // Close bell entries that no longer apply (trip ended, tracker unassigned) — a recovered tracker is
  // already resolved by its next ping in livePing.service.js.
  const stillSilentCars = new Set(
    sessions.filter((s) => s.data.silentAlertedAt || silent.some((x) => x.data.carID === s.data.carID)).map((s) => s.data.carID)
  );
  const open = await db.collection("notifications").where("type", "==", NOTIF_TYPE).where("status", "==", "active").get();
  const staleCars = new Set(open.docs.map((d) => d.data().refID).filter((id) => id && !stillSilentCars.has(id)));
  for (const carID of staleCars) await resolveNotification(NOTIF_TYPE, carID);

  return { activeTrips: sessions.length, alerted: silent.length, resolved: staleCars.size };
};

/** Throttled version, safe to call from every ping / map poll. Never throws. */
export const maybeCheckSilentTrackers = async () => {
  const nowMs = Date.now();
  if (running || nowMs - lastRunAt < CHECK_EVERY_MS) return;
  running = true;
  lastRunAt = nowMs; // set up front so a failing run isn't retried on every ping
  try {
    await runSilentTrackerCheck();
  } catch (err) {
    console.error("[GPS] silent-tracker check failed:", err.message);
  } finally {
    running = false;
  }
};