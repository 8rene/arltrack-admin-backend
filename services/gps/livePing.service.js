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

// ── One ping at a time PER CAR ───────────────────────────────────
// The controller fires processLivePing without waiting for it, and a ping can take seconds (reverse-geocoding is
// queued ~1.1 s apart), so pings for the same car used to overlap: each read the session BEFORE the previous one had
// written, saw the same "last alert", and added its own Started / Back Inside Zone entry. Chaining them makes every
// ping read what the one before it wrote. In-memory, so it covers one server instance. A failed ping never blocks the
// ones behind it.
const carQueues = new Map(); // carID -> promise of the last queued ping

export const processLivePing = (carID, lat, lng, speed = 0, offline = false, recordedAt = new Date()) => {
  const previous = carQueues.get(carID) || Promise.resolve();
  const run = previous.then(() => processLivePingNow(carID, lat, lng, speed, offline, recordedAt));
  const tail = run.catch(() => {});
  carQueues.set(carID, tail);
  tail.then(() => { if (carQueues.get(carID) === tail) carQueues.delete(carID); });
  return run;
};

// A ping that is OLDER than the last alert it would change (an offline backlog arriving out of order, or a late ping
// overtaking a newer one) says nothing about the car's current state, so it must not raise or clear anything.
const isOlderThanLastAlert = (lastAlert, pingTime) => {
  const lastAt = lastAlert?.at ? Date.parse(lastAlert.at) : NaN;
  return !Number.isNaN(lastAt) && pingTime.getTime() < lastAt;
};

// ── Coding-restriction helpers (no new session field: everything is read from data the session already has) ──

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const phtDayAndMinutes = (d) => {
  const p = new Date(d.getTime() + PHT_OFFSET_MS);
  return { day: p.toISOString().slice(0, 10), minutes: p.getUTCHours() * 60 + p.getUTCMinutes() };
};

// "8:00 PM" / "08:00 PM" -> minutes after midnight, or null if it can't be read.
const parseClock = (t) => {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + parseInt(m[2], 10);
};

// The "restricted" entry saved the rule that fired (rule.end, e.g. "8:00 PM"). Once the ping's Manila time is past that
// end time, or it is a later Manila day, the restriction is over for a TIME reason, which a city-name wobble can't fake.
// False when the entry has no readable rule (older entries / fixed-schedule entries): then we can't tell, so the
// two-ping check below decides instead.
const codingWindowOver = (restrictedAlert, pingTime) => {
  const startedAt = restrictedAlert?.at ? new Date(restrictedAlert.at) : null;
  const endMin = parseClock(restrictedAlert?.rule?.end);
  if (!startedAt || Number.isNaN(startedAt.getTime()) || endMin === null) return false;
  const a = phtDayAndMinutes(startedAt);
  const p = phtDayAndMinutes(pingTime);
  return p.day !== a.day || p.minutes >= endMin;
};

// Answers that are about the DAY / PLATE / OVERRIDE, not about which city a spot belongs to, so they are always trusted.
const DEFINITIVE_NOT_RESTRICTED = new Set(["holiday-suspended", "suspended", "no-plate-digit"]);

// A result we can build an alert change on. A geocode failure makes resolveCodingRestriction fall back to the fixed MMDA
// schedule (it ignores the city, and for e.g. a plate ending in 9 says "not restricted" on a Tuesday), which is NOT the
// real answer for a car inside a city rule. Using it was writing a bogus "Ended" followed by a new "Started".
const isUsableCodingResult = (r) =>
  !!r && r.restricted !== null && !String(r.reason || "").startsWith("fallback-fixed-rule");

const processLivePingNow = async (carID, lat, lng, speed, offline, recordedAt) => {
  const session = await getActiveSessionByCarCached(carID);
  if (!session) return; // no active trip on this car — nothing more to do

  const { ref, data } = session;
  const now = recordedAt;
  const receivedAt = new Date();

  // A ping recorded at or before the newest position this session already holds (an offline backlog arriving
  // out of order, a retransmitted record, or a late ping overtaking a newer one) says nothing about where the car is
  // NOW. It must not raise or clear any alert, and must not drag currentPosition back in time. It is still saved to
  // the Sheets ping log under its real time, so the trail and history stay complete.
  const latestKnownAt = data.currentPosition?.date ? Date.parse(data.currentPosition.date) : NaN;
  if (!Number.isNaN(latestKnownAt) && now.getTime() <= latestKnownAt) {
    try {
      await appendCarPing({ carId: carID, sessionId: data.bookingSessionID, lat, lng, at: now.toISOString(), speed, offline });
    } catch (err) {
      console.error("[GPS] Sheets append failed for a stale ping:", err.message);
    }
    return;
  }
  const delayed = receivedAt.getTime() - now.getTime() > DELAYED_PING_MS;
  // Stamped on every alert entry written from this ping: `at` stays the time it HAPPENED (tracker clock),
  // `receivedAt` is when the server heard about it, `delayed` only appears when the gap is significant.
  const lateFields = { receivedAt: receivedAt.toISOString(), ...(delayed ? { delayed: true } : {}) };
  const lateNote = delayed ? ` (happened ${fmtManila(now)}, received late)` : "";

  // Where the PREVIOUS ping put the car (this session doc still holds it — it is overwritten by this ping's write below).
  const prevPosition = data.currentPosition;

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
  const decision = isOlderThanLastAlert(lastGeofenceAlert, now)
    ? { entry: null, count: Number(data.geofenceFlipCount) || 0 } // out-of-order ping: leave the geofence state alone
    : decideGeofence({
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
  // City-aware: reverse-geocodes this ping's actual (lat, lng) and checks it against Firestore's codingRules
  // (per-rule city, day, time window, plus holiday suspension). See coding.service.js's header.
  //
  // The answer depends on which city Nominatim puts this exact spot in, which can wobble ping to ping near a city line,
  // and a failed lookup used to switch to the fixed MMDA schedule. Either made a restriction that is really on all day
  // log "Started" / "Ended" over and over. So an alert only changes when:
  //   - Started:  this ping AND the previous ping both say restricted (the first ping of a trip has no previous one, so
  //               it counts on its own);
  //   - Ended:    the day / plate / override says so (holiday, suspended), OR the rule's own end time has passed, OR this
  //               ping AND the previous ping both say not restricted (the car really left the city's rule);
  //   - a fixed-schedule fallback answer, or an out-of-order ping, never changes anything.
  // "The previous ping" is the position this session doc already stores, so nothing new is saved anywhere.
  const plateNumber = await getPlateNumber(carID);
  const codingSuspended = data.codingSuspended === true;
  const codingResult = await resolveCodingRestriction(plateNumber, lat, lng, now, codingSuspended);
  const lastCodingAlert = (data.codingAlerts || [])[data.codingAlerts?.length - 1];
  const wasRestricted = lastCodingAlert?.type === "restricted";

  // Does the PREVIOUS ping's spot give the same answer? (Usually a cache hit: that spot was just geocoded.)
  const previousPingAgrees = async (wantRestricted) => {
    const hasPrev = prevPosition && typeof prevPosition.lat === "number" && typeof prevPosition.lng === "number";
    if (!hasPrev) return wantRestricted; // nothing to compare: a trip's first ping may start a restriction, never end one
    const prev = await resolveCodingRestriction(plateNumber, prevPosition.lat, prevPosition.lng, now, codingSuspended);
    return isUsableCodingResult(prev) && prev.restricted === wantRestricted;
  };

  let codingChange = null; // "restricted" | "cleared" | null
  if (isUsableCodingResult(codingResult) && !isOlderThanLastAlert(lastCodingAlert, now) && codingResult.restricted !== wasRestricted) {
    if (codingResult.restricted) {
      if (await previousPingAgrees(true)) codingChange = "restricted";
    } else if (
      DEFINITIVE_NOT_RESTRICTED.has(codingResult.reason) ||
      codingWindowOver(lastCodingAlert, now) ||
      (await previousPingAgrees(false))
    ) {
      codingChange = "cleared";
    }
  }

  if (codingChange === "restricted") {
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
  } else if (codingChange === "cleared") {
    updates.codingAlerts = admin.firestore.FieldValue.arrayUnion({
      type: "cleared",
      at: now.toISOString(),
      // The rule's own end time passed (vs. the car actually leaving the area) — the log shows "Coding window ended".
      ...(codingWindowOver(lastCodingAlert, now) ? { windowEnded: true } : {}),
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