// The missing middle piece: called on every GPS ping AFTER the raw
// coordinate write (gps.controller.js still writes gpsLocations/gpsDevice
// as before — this is additive, not a replacement). If the car has no
// active session, this is a no-op — idle/anti-theft tracking doesn't need
// geofence or coding checks, only a session with a booking behind it does.

import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { getActiveSessionByCar } from "../../services/booking/bookingSession.service.js";
import { checkGeofence } from "./geofence.service.js";
import { resolveCodingRestriction } from "./coding.service.js";
import { appendCarPing } from "../sheets/sheets.service.js";

/** Small in-memory cache for plateNumber lookups — rarely changes, cheap to cache per car. */
const plateCache = {};
const getPlateNumber = async (carID) => {
  if (plateCache[carID]) return plateCache[carID];
  const carDoc = await db.collection("cars").doc(carID).get();
  const plate = carDoc.exists ? (carDoc.data().plateNumber || "") : "";
  plateCache[carID] = plate;
  return plate;
};

/**
 * @param {string} carID
 * @param {number} lat
 * @param {number} lng
 * @param {number} [speed] — km/h, straight from the tracker's own reading (not derived here)
 * @param {boolean} [offline] — true when this ping was buffered by the tracker while it had
 *   no signal and sent later on reconnect, rather than reported live
 * @param {Date} [recordedAt] — the tracker's real GNSS timestamp for this ping. Passed
 *   through as `now` below so geofence/coding alerts and the Sheets ping log (including
 *   which date-tab it's routed to) reflect when the ping actually happened, not when the
 *   backlog happened to flush. Defaults to receive time if the caller didn't have one.
 */
export const processLivePing = async (carID, lat, lng, speed = 0, offline = false, recordedAt = new Date()) => {
  const session = await getActiveSessionByCar(carID);
  if (!session) return; // no active trip on this car — nothing more to do

  const { ref, data } = session;
  const now = recordedAt;
  const updates = {
    currentPosition: { lat, lng, date: now.toISOString() },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // ── Geofence check ──────────────────────────────────────────────
  const geofenceResult = checkGeofence(lat, lng, data.geofenceZones || []);
  const lastGeofenceAlert = (data.geofenceAlerts || [])[data.geofenceAlerts?.length - 1];
  const wasBreached = lastGeofenceAlert?.type === "breach";
  if (geofenceResult.breached && !wasBreached) {
    updates.geofenceAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "breach",
      nearestZone: geofenceResult.nearestZone,
      distanceMeters: geofenceResult.distanceMeters,
      at: now.toISOString(),
    });
  } else if (!geofenceResult.breached && wasBreached) {
    updates.geofenceAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "cleared",
      zone: geofenceResult.nearestZone,
      at: now.toISOString(),
    });
  }
  // else: state unchanged since the last recorded alert — don't spam an
  // entry on every single ping, only on breach/clear transitions.

  // ── Coding-restriction check ────────────────────────────────────
  // Now city-aware: reverse-geocodes this ping's actual (lat, lng) and
  // checks it against Firestore's codingRules — the same source of truth
  // the customer backend's booking-time check uses — instead of the old
  // fixed-schedule-only rule. See coding.service.js's header for the
  // fallback behavior if the geocode lookup itself fails.
  const plateNumber = await getPlateNumber(carID);
  const codingResult = await resolveCodingRestriction(plateNumber, lat, lng, now, data.codingSuspended === true);
  const lastCodingAlert = (data.codingAlerts || [])[data.codingAlerts?.length - 1];
  const wasRestricted = lastCodingAlert?.type === "restricted";
  if (codingResult.restricted && !wasRestricted) {
    updates.codingAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "restricted",
      reason: codingResult.reason,
      city: codingResult.city || null,
      at: now.toISOString(),
    });
  } else if (!codingResult.restricted && wasRestricted) {
    updates.codingAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "cleared",
      at: now.toISOString(),
    });
  }

  await ref.update(updates);

  // ── Append this ping to the Sheets ping log ──────────────────────
  // Direct append, no interval/batch buffer — see sheets.service.js's header
  // note for why (Vercel's serverless model can freeze/kill this function
  // instance the moment the response is sent, so a buffered write sitting in
  // memory could silently vanish). Logs on failure but never throws — a
  // failed Sheets write must not undo the session update that already
  // succeeded above.
  try {
    await appendCarPing({
      carId: carID,
      sessionId: data.bookingSessionID,
      lat,
      lng,
      at: now.toISOString(),
      speed,
      offline,
    });
  } catch (err) {
    console.error("[GPS] Sheets append failed (session doc was still updated):", err.message);
  }
};