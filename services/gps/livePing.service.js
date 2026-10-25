// The missing middle piece: called on every GPS ping AFTER the raw
// coordinate write (gps.controller.js still writes gpsLocations/gpsDevice
// as before — this is additive, not a replacement). If the car has no
// active session, this is a no-op — idle/anti-theft tracking doesn't need
// geofence or coding checks, only a session with a booking behind it does.

import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { getActiveSessionByCarCached } from "../../services/booking/bookingSession.service.js";
import { checkGeofence, decideGeofence } from "./geofence.service.js";
import { resolveCodingRestriction, maskPlate } from "./coding.service.js";
import { appendCarPing } from "../sheets/sheets.service.js";
import { notifyStaff, resolveNotification } from "../notification/notification.service.js";

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
// A ping that reaches the server this long after the tracker recorded it counts as "received late"
// (typically an offline flush). Alerts raised from it say so, instead of looking like fresh news.
const DELAYED_PING_MS = 2 * 60 * 1000;
const fmtManila = (d) =>
  d.toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const processLivePing = async (carID, lat, lng, speed = 0, offline = false, recordedAt = new Date()) => {
  const session = await getActiveSessionByCarCached(carID);
  if (!session) return; // no active trip on this car — nothing more to do

  const { ref, data } = session;
  const now = recordedAt;
  const receivedAt = new Date();
  const delayed = receivedAt.getTime() - now.getTime() > DELAYED_PING_MS;
  // Stamped on every alert entry written from this ping: `at` stays the time it HAPPENED (tracker clock),
  // `receivedAt` is when the server heard about it, `delayed` only appears when the gap is significant.
  const lateFields = { receivedAt: receivedAt.toISOString(), ...(delayed ? { delayed: true } : {}) };
  const lateNote = delayed ? ` (happened ${fmtManila(now)}, received late)` : "";

  const updates = {
    currentPosition: { lat, lng, date: now.toISOString() },
    // Server-side "last heard from the tracker" — unlike currentPosition.date (tracker time, can be an old
    // replayed fix). Same write, no extra cost.
    lastPingReceivedAt: receivedAt.toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  // ── Geofence check ──────────────────────────────────────────────
  const geofenceResult = checkGeofence(lat, lng, data.geofenceZones || []);
  const lastGeofenceAlert = (data.geofenceAlerts || [])[data.geofenceAlerts?.length - 1];
  const wasBreached = lastGeofenceAlert?.type === "breach";
  // Marked dropped off = the customer is released. The trip stays open (the car may still be driven to
  // maintenance and keeps being recorded), but geofence alerts are the customer's, so they stop here.
  // Coding-restriction alerts keep going: a coding fine is yours whoever is driving.
  const droppedOff = !!data.droppedOffTime;
  // Two pings in a row must disagree with the logged state before it changes (see geofence.service.js),
  // so a single bad fix or a car on a zone edge can't raise or clear an alert. The running count lives on
  // the session and rides in the same write as everything else — no extra read or write.
  const decision = decideGeofence({
    breached: geofenceResult.breached,
    wasBreached,
    flipCount: data.geofenceFlipCount,
    droppedOff,
  });
  if (decision.entry === "breach") {
    updates.geofenceAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "breach",
      nearestZone: geofenceResult.nearestZone,
      distanceMeters: geofenceResult.distanceMeters,
      at: now.toISOString(),
      ...lateFields,
    });
    // Notification is keyed by carID and only fired on the transition, same
    // as the log entry above — one active bell entry per car per breach
    // episode, not one per ping.
    // Fanned out to Owner/Admin/Supervisor (notifyStaff), not the driver —
    // drivers don't have access to the tracker/device or a UI to act on
    // this, so notifying them would just be noise.
    notifyStaff({
      type: "geofence_alert",
      refID: carID,
      refCollection: "cars",
      title: "Vehicle left its zone",
      message: `Car is currently outside its allowed zone${geofenceResult.nearestZone ? ` (nearest: ${geofenceResult.nearestZone})` : ""}.${lateNote}`,
    }).catch((err) => console.error("[NOTIF] geofence_alert create failed:", err.message));
  } else if (decision.entry === "cleared") {
    updates.geofenceAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "cleared",
      zone: geofenceResult.nearestZone,
      at: now.toISOString(),
      // Closed because the car was dropped off while it was still outside, not because it came back.
      ...(decision.afterDropOff ? { afterDropOff: true } : {}),
      ...lateFields,
    });
    resolveNotification("geofence_alert", carID)
      .catch((err) => console.error("[NOTIF] geofence_alert resolve failed:", err.message));
  }
  // Keep the stored count in step; only touch the field when it actually changes.
  if ((Number(data.geofenceFlipCount) || 0) !== decision.count) updates.geofenceFlipCount = decision.count;

  // ── Coding-restriction check ────────────────────────────────────
  // City-aware: reverse-geocodes this ping's actual (lat, lng) and checks it
  // against Firestore's codingRules (per-rule city, day, time window, plus
  // holiday suspension). See coding.service.js's header for the fallback
  // behaviour if the geocode lookup itself fails.
  const plateNumber = await getPlateNumber(carID);
  const codingResult = await resolveCodingRestriction(plateNumber, lat, lng, now, data.codingSuspended === true);
  const lastCodingAlert = (data.codingAlerts || [])[data.codingAlerts?.length - 1];
  const wasRestricted = lastCodingAlert?.type === "restricted";
  if (codingResult.restricted === null) {
    // Couldn't tell whether today is a holiday — leave the coding state exactly as it is
    // (no new restriction, no "cleared") rather than guess.
  } else if (codingResult.restricted && !wasRestricted) {
    updates.codingAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "restricted",
      reason: codingResult.reason,
      city: codingResult.city || null,
      // The rule exactly as it was when it fired ({ id, city, day, start, end,
      // digits }), so history still shows what applied after rules are edited.
      // Omitted (not undefined — Firestore rejects that) for older callers.
      ...(codingResult.rule ? { rule: codingResult.rule } : {}),
      // Which plate this applied to, masked ("AB****3"): the rule's digits alone don't say, and the full plate
      // must not end up in the public history file. A plate corrected later can't change what was recorded.
      ...(maskPlate(plateNumber) ? { plate: maskPlate(plateNumber) } : {}),
      // Coding keeps being recorded after drop-off (the fine is yours whoever drives); this tags those entries.
      ...(droppedOff ? { afterDropOff: true } : {}),
      at: now.toISOString(),
      ...lateFields,
    });
    // Same reasoning as geofence_alert above — staff-only, driver can't act on it.
    notifyStaff({
      type: "coding_alert",
      refID: carID,
      refCollection: "cars",
      title: "Coding restriction",
      message: `Car is currently in a number-coding restricted zone${codingResult.city ? ` (${codingResult.city})` : ""}.${lateNote}`,
    }).catch((err) => console.error("[NOTIF] coding_alert create failed:", err.message));
  } else if (!codingResult.restricted && wasRestricted) {
    updates.codingAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "cleared",
      at: now.toISOString(),
      ...lateFields,
    });
    resolveNotification("coding_alert", carID)
      .catch((err) => console.error("[NOTIF] coding_alert resolve failed:", err.message));
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