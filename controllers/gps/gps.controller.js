import { saveLocation } from "../../services/gps/gps.service.js";
import {
  getLiveLocationsCached,
  getCachedDevice, setCachedDevice,
  getCachedLocDocId, setCachedLocDocId, clearLocDocId,
  clearGpsDeviceCaches,
  shouldSkipLocationWrite, markLocationWritten,
} from "../../services/gps/gpsLookupCache.js";
import { processLivePing } from "../../services/gps/livePing.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import { getBookingCompletedAt } from "../../services/booking/booking.service.js";
import { getHolidaysBetween } from "../../services/gps/coding.service.js";
import { getSessionsByCar, getActiveSessionByCar, getSessionById, getRecentSessionsByCarUpTo, getArchivePointCount } from "../../services/booking/bookingSession.service.js";
import { getSessionArchivesByCar, getRecentSessionArchivesByCarUpTo } from "../../services/archives/bookingSessionArchives.service.js";
import { fetchCarRowsForDate } from "../../services/sheets/sheets.service.js";
import { datesBetweenPHT } from "../../utils/date/phtDate.js";
import { sessionStartedAt, sessionEndedAt } from "../../utils/date/sessionDates.js";
import { isWithinPhilippines } from "../../utils/gps/philippinesBounds.js";
import admin from "firebase-admin";

// Booking-time Number Coding warnings (session.codingWarnings): a FLAT array, one entry per
// matched rule — { city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }. No timestamps
// inside, so it passes straight through. [] on older sessions.
const codingWarningsOut = (list) => (Array.isArray(list) ? list : []);

// Firestore Timestamp / Date / string -> ISO string, or null.
const toIso = (v) => {
  const d = v?.toDate ? v.toDate() : v ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString() : null;
};

/** POST /api/gps  — GPS device pushes a live location */
export const receiveLocation = async (req, res) => {
  const { device_id, lat, lng, speed, offline, recorded_at } = req.body;
  if (!device_id || lat == null || lng == null) {
    return res.status(400).json({ status: "error", message: "device_id, lat, lng required." });
  }
  // device_id is used as a Firestore query value and as an in-memory cache key,
  // so it must be a plain, reasonably short string (real ids are 20-char Firestore doc ids).
  if (typeof device_id !== "string" || device_id.length > 128) {
    return res.status(400).json({ status: "error", message: "Invalid device_id." });
  }

  const latVal = parseFloat(lat);
  const lngVal = parseFloat(lng);

  // Plausibility check — catches wildly-wrong fixes (bad GPS chip, cold
  // start, multipath — the kind of glitch that reports a point on another
  // continent while the car hasn't moved) before they're saved anywhere.
  // Silent drop, by design: no error surfaced to the device, nothing
  // written to gpsLocations/gpsDevice/session/Sheets for this ping. See
  // utils/gps/philippinesBounds.js for what this box does and doesn't catch.
  if (!isWithinPhilippines(latVal, lngVal)) {
    console.warn(`[GPS] Dropped out-of-bounds ping from ${device_id}: lat=${lat}, lng=${lng}`);
    return res.status(200).json({ status: "ok", ignored: true });
  }

  // speed: defaults to 0 if the tracker doesn't send it (older firmware, etc).
  // offline: the tracker itself flags this true on buffered/replayed pings
  // (queued while it had no signal, sent once it reconnects) — not inferred
  // here, just passed through as-is.
  const speedVal   = speed != null ? parseFloat(speed) || 0 : 0;
  const offlineVal = offline === true || offline === "true";

  // Prefer the tracker's own GNSS timestamp over receive time — critical for
  // offline-buffered pings, which otherwise all land bunched together at
  // whatever moment the backlog happened to flush instead of when each point
  // actually occurred. Falls back to receive time if missing/unparseable so a
  // malformed or older-firmware payload never crashes the ping.
  let recordedAt = new Date();
  if (recorded_at) {
    const parsed = new Date(recorded_at);
    if (!isNaN(parsed.getTime())) {
      recordedAt = parsed;
    } else {
      console.warn(`[GPS] ⚠️ ${device_id} sent unparseable recorded_at ("${recorded_at}") — using receive time instead`);
    }
  }

  // ── gpsDevice: is this a REGISTERED device, and which car is it on? ─────
  // Checked BEFORE anything is saved, so a ping from an unknown device_id
  // creates no gpsLocations doc, no cache entry and no live-map marker.
  // Cached for ~60s (cleared on any device add/assign/unassign/edit/delete)
  // so a ping doesn't re-run the same `where` query every few seconds — a
  // registered tracker costs about one read a minute, "not found" included.
  let dev = getCachedDevice(device_id);
  if (!dev) {
    try {
      const deviceSnap = await db.collection("gpsDevice")
        .where("gpsDeviceID", "==", device_id).limit(1).get();
      dev = deviceSnap.empty
        ? { docId: null, carID: null }
        : { docId: deviceSnap.docs[0].id, carID: deviceSnap.docs[0].data().carID || null };
      setCachedDevice(device_id, dev);
    } catch (err) {
      // Can't verify the device, so don't accept the ping (fail closed).
      // 503 lets a tracker that buffers/retries resend it later.
      console.error("[GPS] gpsDevice lookup failed:", err.message);
      return res.status(503).json({ status: "error", message: "Temporarily unable to verify device." });
    }
  }
  if (!dev.docId) {
    // Silent drop, same style as the out-of-bounds check above: a 200 so a
    // tracker doesn't hammer retries, nothing saved anywhere.
    console.warn(`[GPS] Dropped ping from unregistered device_id (len=${device_id.length})`);
    return res.status(200).json({ status: "ok", ignored: true });
  }

  // A parked tracker re-sends the same fix every few seconds; skip the
  // Firestore writes for those (heartbeat + movement still go through).
  const skipWrite = shouldSkipLocationWrite(device_id, latVal, lngVal, speedVal, offlineVal);

  let data;
  try {
    data = await saveLocation(device_id, lat, lng, recordedAt, { persist: !skipWrite });
  } catch (err) {
    console.error("[GPS] saveLocation failed:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to save location." });
  }

  // gpsDevice's own updatedAt: when the tracker last reported (device is known to exist here).
  if (!skipWrite) {
    try {
      await db.collection("gpsDevice").doc(dev.docId).update({
        updatedAt: admin.firestore.Timestamp.fromDate(recordedAt),
      });
    } catch (err) {
      clearGpsDeviceCaches(); // doc may have been deleted/replaced — re-lookup next ping
      console.error("[GPS] gpsDevice update failed:", err.message);
    }
  }

  // Trip logic (geofence / coding / Sheets log) must see EVERY ping, so it is
  // never skipped — only the redundant location-doc writes above/below are.
  if (dev.carID) {
    processLivePing(dev.carID, latVal, lngVal, speedVal, offlineVal, recordedAt).catch((err) =>
      console.error("[GPS] processLivePing failed (raw ping was still saved):", err.message)
    );
  }

  // ── gpsLocations: the doc the live map reads ─────────────────────────────
  if (!skipWrite) {
    try {
      const locPayload = {
        latitude:   latVal,
        longtitude: lngVal, // preserving existing typo in DB
        speed:      speedVal,
        offline:    offlineVal,
        updatedAt:  admin.firestore.Timestamp.fromDate(recordedAt),
      };

      let updated = false;
      const cachedLocId = getCachedLocDocId(device_id);
      if (cachedLocId) {
        try {
          await db.collection("gpsLocations").doc(cachedLocId).update(locPayload);
          updated = true;
        } catch (err) {
          clearLocDocId(device_id); // stale id — fall through to the query path
        }
      }

      if (!updated) {
        const locSnap = await db.collection("gpsLocations")
          .where("gpsDeviceID", "==", device_id).limit(1).get();

        if (!locSnap.empty) {
          await locSnap.docs[0].ref.update(locPayload);
          setCachedLocDocId(device_id, locSnap.docs[0].id);
        } else {
          const ref = await db.collection("gpsLocations").add({
            gpsDeviceID: device_id,
            ...locPayload,
            createdAt:   admin.firestore.FieldValue.serverTimestamp(), // doc creation bookkeeping — receive time is correct here
          });
          setCachedLocDocId(device_id, ref.id);
        }
      }
      markLocationWritten(device_id, latVal, lngVal, speedVal, offlineVal);
    } catch (err) {
      console.error("[GPS] Firestore update failed:", err.message);
    }
  }

  return res.json({ status: "ok", data });
};

/** GET /api/gps/:id  — Frontend reads one device's location from Firestore */
export const getDeviceLocation = async (req, res) => {
  try {
    const deviceId = req.params.id;

    const locSnap = await db.collection("gpsLocations")
      .where("gpsDeviceID", "==", deviceId).limit(1).get();

    if (!locSnap.empty) {
      const doc = locSnap.docs[0].data();
      return res.json({
        deviceId,
        lat:          parseFloat(doc.latitude)   || null,
        lng:          parseFloat(doc.longtitude) || parseFloat(doc.longitude) || null,
        speed:        typeof doc.speed === "number" ? doc.speed : 0,
        offline:      doc.offline === true,
        lastLocation: doc.lastLocation || null,
        updatedAt:    doc.updatedAt?.toDate?.()?.toISOString?.() || null,
      });
    }

    return res.json({});
  } catch (err) {
    console.error("[GPS] getDeviceLocation error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch device location." });
  }
};

/** GET /api/gps  — Frontend reads ALL devices that have a stored location */
export const getAllDeviceLocations = async (req, res) => {
  try {
    // Shared ~15s cache: no matter how many staff have the map open (or how
    // often they poll), Firestore is read at most about once per window.
    const data = await getLiveLocationsCached(async () => {
    const snap = await db.collection("gpsLocations").get();
    return snap.docs
      .map(d => {
        const doc = d.data();
        const lat = parseFloat(doc.latitude)   || doc.lastLocation?.latitude  || null;
        const lng = parseFloat(doc.longtitude) || parseFloat(doc.longitude)
                 || doc.lastLocation?.longitude || null;

        if (!lat || !lng) return null;

        return {
          deviceId:     doc.gpsDeviceID,
          lat,
          lng,
          speed:        typeof doc.speed === "number" ? doc.speed : 0,
          offline:      doc.offline === true,
          lastLocation: doc.lastLocation || null,
          updatedAt:    doc.updatedAt?.toDate?.()?.toISOString?.() || null,
        };
      })
      .filter(Boolean);
    });

    return res.json({ status: "ok", data });
  } catch (err) {
    console.error("[GPS] getAllDeviceLocations error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch locations." });
  }
};

/** GET /api/gps/devices  — Get all GPS devices from gpsDevice collection */
export const getAllGpsDevices = async (req, res) => {
  try {
    // NOTE: previously used .orderBy("gpsName") here — Firestore silently
    // EXCLUDES any document missing the ordered field from the results
    // (no error, it just vanishes). Any device doc without a gpsName
    // (hand-created, seeded before the field existed, etc.) would never
    // show up on the page. Fetch everything and sort in memory instead so
    // no device can go missing just because a field is blank.
    const snap = await db.collection("gpsDevice").get();
    const devices = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.gpsName || "").localeCompare(b.gpsName || ""));
    return res.json({ status: "ok", data: devices });
  } catch (err) {
    console.error("[GPS] getAllGpsDevices error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch GPS devices." });
  }
};

/** POST /api/gps/devices  — Add a new GPS device (assigned = false by default) */
export const addGpsDevice = async (req, res) => {
  clearGpsDeviceCaches(); // device/assignment is changing — drop cached lookups
  try {
    const snap  = await db.collection("gpsDevice").get();
    const count = snap.size + 1;

    const docRef = db.collection("gpsDevice").doc();

    await docRef.set({
      gpsDeviceID: docRef.id,
      gpsName:     `Gps Device Location ${count}`,
      assigned:    false,
      carID:       "",
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    const newDoc = await docRef.get();
    return res.status(201).json({ status: "ok", data: { id: docRef.id, ...newDoc.data() } });
  } catch (err) {
    console.error("[GPS] addGpsDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to add GPS device." });
  }
};

/** PUT /api/gps/devices/:id/unassign  — Detach a car from a GPS device */
export const unassignDeviceFromCar = async (req, res) => {
  clearGpsDeviceCaches(); // device/assignment is changing — drop cached lookups
  const { id } = req.params;

  try {
    const docRef = db.collection("gpsDevice").doc(id);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "GPS device not found." });
    }

    const { carID: previousCarID } = doc.data();

    await docRef.update({
      carID:     "",
      assigned:  false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Reverse of assignCarToDevice's sync — that car's upcoming bookings no
    // longer have a device, so Car Tracking's badge should reappear for them.
    if (previousCarID) {
      const upcomingSnap = await db.collection("bookings")
        .where("carID", "==", previousCarID)
        .where("status", "==", "upcoming")
        .get();

      if (!upcomingSnap.empty) {
        const batch = db.batch();
        upcomingSnap.docs.forEach((doc) => batch.update(doc.ref, { hasDevice: false }));
        await batch.commit();
      }
    }

    return res.json({ status: "ok", message: "Car unassigned from GPS device." });
  } catch (err) {
    console.error("[GPS] unassignDeviceFromCar error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to unassign car." });
  }
};

/** PATCH /api/gps/devices/:id  — Rename a GPS device */
export const updateGpsDevice = async (req, res) => {
  clearGpsDeviceCaches(); // device/assignment is changing — drop cached lookups
  const { id }      = req.params;
  const { gpsName } = req.body;

  if (!gpsName || !gpsName.trim()) {
    return res.status(400).json({ status: "error", message: "gpsName is required." });
  }

  try {
    const docRef = db.collection("gpsDevice").doc(id);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "GPS device not found." });
    }

    await docRef.update({
      gpsName:   gpsName.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const updated = await docRef.get();
    return res.json({ status: "ok", data: { id: docRef.id, ...updated.data() } });
  } catch (err) {
    console.error("[GPS] updateGpsDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to rename GPS device." });
  }
};

/** DELETE /api/gps/devices/:id  — Permanently remove a GPS device */
export const deleteGpsDevice = async (req, res) => {
  clearGpsDeviceCaches(); // device/assignment is changing — drop cached lookups
  const { id } = req.params;

  try {
    const docRef = db.collection("gpsDevice").doc(id);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "GPS device not found." });
    }

    await docRef.delete();
    return res.json({ status: "ok", message: "GPS device deleted." });
  } catch (err) {
    console.error("[GPS] deleteGpsDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to delete GPS device." });
  }
};
export const assignCarToDevice = async (req, res) => {
  clearGpsDeviceCaches(); // device/assignment is changing — drop cached lookups
  const { id }    = req.params;
  const { carID } = req.body;

  if (!carID) {
    return res.status(400).json({ status: "error", message: "carID is required." });
  }

  try {
    const docRef = db.collection("gpsDevice").doc(id);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "GPS device not found." });
    }

    await docRef.update({
      carID:     carID,
      assigned:  true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Sync to booking: any upcoming booking for this car no longer has a
    // "no device" gap — this is what Car Tracking's badge query reads.
    const upcomingSnap = await db.collection("bookings")
      .where("carID", "==", carID)
      .where("status", "==", "upcoming")
      .get();

    if (!upcomingSnap.empty) {
      const batch = db.batch();
      upcomingSnap.docs.forEach((doc) => batch.update(doc.ref, { hasDevice: true }));
      await batch.commit();
    }

    return res.json({ status: "ok", message: "Car assigned to GPS device." });
  } catch (err) {
    console.error("[GPS] assignCarToDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to assign car." });
  }
};

/**
 * GET /api/gps/:carId/session
 * The car's ACTIVE trip session only — geofence zones, live position, and
 * the geofence/coding alert logs livePing.service.js has been appending.
 * Powers Car Tracking's "Car Information" and "Logs" floating panels.
 * Returns { hasActiveSession: false } (not an error) when the car isn't on
 * a trip right now — nothing to show zones/logs for in that case.
 */
export const getCarActiveSession = async (req, res) => {
  try {
    const { carId } = req.params;
    const session = await getActiveSessionByCar(carId);
    if (!session) {
      return res.json({ status: "ok", data: { hasActiveSession: false } });
    }
    const { data } = session;
    return res.json({
      status: "ok",
      data: {
        hasActiveSession: true,
        bookingSessionID: data.bookingSessionID,
        status:    data.status,
        geofenceZones:    data.geofenceZones || [],
        geofenceAlerts:   data.geofenceAlerts || [],
        codingAlerts:     data.codingAlerts || [],
        codingWarnings:   codingWarningsOut(data.codingWarnings),
        currentPosition:  data.currentPosition || null,
        // When the car was marked physically dropped off (null until then) — lets the Live Logs panel show it.
        droppedOffAt:     data.droppedOffTime?.toDate ? data.droppedOffTime.toDate().toISOString() : null,
        pickupLocation:   data.pickupLocation || null,
        dropoffLocation:  data.dropoffLocation || null,
      },
    });
  } catch (err) {
    console.error("[GPS] getCarActiveSession error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch car session." });
  }
};

// ── Geofence zones ──────────────────────────────────────────────────────────
// A trip's zones live ONLY on its bookingSessions doc (geofenceZones). The car doc keeps no zones of its
// own. The customer backend writes the first zones at booking time; this endpoint is how staff change them
// afterwards, for an upcoming trip or the active one.
const EDITABLE_SESSION_STATUSES = ["upcoming", "active"];

// Returns an error message, or null when `zones` is a valid [{ label, lat, lng, radius(m) }] list.
const zonesError = (zones) => {
  if (!Array.isArray(zones)) return "zones must be an array.";
  for (const zone of zones) {
    if (!zone || typeof zone.lat !== "number" || typeof zone.lng !== "number" || typeof zone.radius !== "number") {
      return "Each zone needs numeric lat, lng, and radius (meters).";
    }
  }
  return null;
};

// A booking's car, found by the booking's doc ID or by its bookingID field (both are used in this codebase).
const carIdOfBooking = async (bookingID) => {
  if (!bookingID) return null;
  const direct = await db.collection("bookings").doc(bookingID).get();
  if (direct.exists) return direct.data().carID || null;
  const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? null : (snap.docs[0].data().carID || null);
};

// Which session a geofence edit applies to:
//  - no bookingSessionID: the car's active session (what Car Tracking's Traceback tab sends).
//  - bookingSessionID: that session, which must be upcoming or active and must belong to this car.
//    An upcoming session has no carID yet (it is set at pickup), so its booking decides the car.
// Returns { session } or { error: { code, message } }.
const resolveGeofenceSession = async (carId, bookingSessionID) => {
  if (!bookingSessionID) {
    const session = await getActiveSessionByCar(carId);
    if (!session) {
      return { error: { code: 404, message: "This car has no active trip. Choose an upcoming booking to set its zones." } };
    }
    return { session };
  }
  if (typeof bookingSessionID !== "string") {
    return { error: { code: 400, message: "bookingSessionID must be a string." } };
  }
  const session = await getSessionById(bookingSessionID);
  if (!session) {
    return { error: { code: 404, message: "Trip session not found." } };
  }
  if (!EDITABLE_SESSION_STATUSES.includes(session.data.status)) {
    return { error: { code: 409, message: `This trip is ${session.data.status}, so its zones can no longer be changed.` } };
  }
  const sessionCarId = session.data.carID || await carIdOfBooking(session.data.bookingID);
  if (sessionCarId !== carId) {
    return { error: { code: 404, message: "That trip does not belong to this car." } };
  }
  return { session };
};

/**
 * PATCH /api/gps/:carId/geofence
 * Body: { zones: [{ label, lat, lng, radius }], bookingSessionID? } — radius in METERS, matching
 * geofence.service.js's haversine comparison (NOT km — that's the geo-test's convention, not this one).
 * Overwrites the session's geofenceZones wholesale, so the frontend always sends the full edited list
 * (add/remove/resize all happen client-side first, then one save).
 * With bookingSessionID: that upcoming or active trip. Without it: the car's active trip.
 */
export const updateCarGeofence = async (req, res) => {
  try {
    const { carId } = req.params;
    const { zones, bookingSessionID } = req.body;

    const invalid = zonesError(zones);
    if (invalid) {
      return res.status(400).json({ status: "error", message: invalid });
    }

    const { session, error } = await resolveGeofenceSession(carId, bookingSessionID);
    if (error) {
      return res.status(error.code).json({ status: "error", message: error.message });
    }

    await session.ref.update({
      geofenceZones: zones,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ status: "ok", message: "Geofence zones updated.", data: { zones } });
  } catch (err) {
    console.error("[GPS] updateCarGeofence error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to update geofence." });
  }
};

/**
 * GET /api/gps/:carId/traceback?date=YYYY-MM-DD
 * One car's full GPS trail for one day — used by Car Tracking's Traceback tab.
 * Ping data now lives in Google Sheets (one tab per PHT date, shared across
 * every car) instead of a per-session Firestore archive/{date} subcollection
 * — see services/sheets/sheets.service.js. A car's trail for a given date is
 * just that date's tab filtered to this car, so no session lookup is needed
 * here anymore (a session lookup IS still needed for History — see below).
 */
export const getCarTraceback = async (req, res) => {
  try {
    const { carId } = req.params;
    const { date, force } = req.query;

    if (!date) {
      return res.status(400).json({ status: "error", message: "date (YYYY-MM-DD) is required." });
    }

    // `force=true` (sent by the frontend's explicit Refresh button) bypasses
    // the short-lived tab-rows cache in sheets.service.js so a deliberate
    // refresh actually reflects the latest pings, instead of serving
    // whatever was cached seconds ago.
    const rows = await fetchCarRowsForDate(carId, date, { force: force === "true" });

    const records = rows
      .filter((r) => typeof r.lat === "number" && typeof r.lng === "number" && r.at)
      .map((r) => ({ lat: r.lat, lng: r.lng, at: r.at, speed: r.speed ?? 0, offline: r.offline === true }))
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    // Geofence-breach / coding-restriction banner needs the zones + alert
    // logs for whichever session actually spans this date — records above
    // come straight from Sheets with no session context, so we look up the
    // session separately here rather than change how records are sourced.
    // A car can have MORE THAN ONE trip on the same date (one finishes, the next is booked and picked up
    // later that day). Trips never overlap in time, but they do share a date, so every trip that touches
    // this date is returned in `sessions` -- each with its OWN zones / alerts / warnings / holidays. The
    // frontend picks the right one for the instant being scrubbed. The top-level fields below stay as
    // they were (the newest trip on the date) so older clients keep working.
    let sessions = [];
    try {
      // A session covers a date from its REAL start (startedAt) to its real end (see sessionEndedAt) or
      // "now" while it's still going. Sessions that never started have no start, so they never match.
      const findMatches = (list) => list.filter((s) => {
        const start = sessionStartedAt(s.data);
        if (!start) return false;
        const end = sessionEndedAt(s.data) || new Date();
        return datesBetweenPHT(start, end).includes(date);
      });

      const endOfDate = new Date(`${date}T23:59:59.999+08:00`); // PHT end of day

      // Live sessions AND archived ones: an earlier trip that has since been archived (its live doc is
      // deleted) can sit on the same date as a newer, still-live trip, so one must not hide the other.
      // Bounded lookups first (a few reads); a full read only if a lookup errors or finds nothing at all.
      const collect = async (getRecent, getAll, isArchived) => {
        let recent = null; // null = bounded lookup unavailable (error); [] = ran, found nothing
        try {
          recent = await getRecent(carId, endOfDate);
        } catch (e) {
          console.warn("[GPS] bounded session lookup failed, using full read:", e.message);
        }
        let matches = recent ? findMatches(recent) : [];
        if (!matches.length && (recent === null || recent.length === 0)) matches = findMatches(await getAll(carId));
        return matches.map((m) => ({ match: m, isArchived }));
      };

      const [live, archived] = await Promise.all([
        // limit 8 (the default is 4): the newest N trips up to the end of the date, so a busy day with
        // several short bookings on one car still finds all of them.
        collect((id, end) => getRecentSessionsByCarUpTo(id, end, 8), getSessionsByCar, false),
        collect((id, end) => getRecentSessionArchivesByCarUpTo(id, end, 8), getSessionArchivesByCar, true),
      ]);

      // Same trip in both places (archived but live doc not yet deleted) -> keep the live one.
      const seen = new Set();
      const all = [...live, ...archived].filter(({ match }) => {
        const id = match.data.bookingSessionID || match.ref?.id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      all.sort((a, b) => (sessionStartedAt(a.match.data)?.getTime() ?? 0) - (sessionStartedAt(b.match.data)?.getTime() ?? 0));

      sessions = await Promise.all(all.map(async ({ match, isArchived }) => {
        const d = match.data;
        const session = {
          bookingSessionID: d.bookingSessionID,
          bookingID:        d.bookingID || null,
          status:           d.status || null,
          startedAt:        sessionStartedAt(d),
          endedAt:          sessionEndedAt(d), // null while still going
          // Event times for the Traceback bar flags and the Logs panel (ISO or null).
          droppedOffAt:     toIso(d.droppedOffTime),
          stolenAt:         toIso(d.stolenAt),
          completedAt:      null, // filled just below, only when the trip really ended (one extra read)
          isArchived,
        };
        if (d.status === "ended") session.completedAt = await getBookingCompletedAt(d.bookingID);
        let holidays = [];
        try {
          holidays = await getHolidaysBetween(sessionStartedAt(d), sessionEndedAt(d) || new Date());
        } catch (hErr) {
          console.error("[GPS] getCarTraceback holidays lookup error:", hErr.message);
        }
        return {
          session,
          geofenceZones:  d.geofenceZones  || [],
          geofenceAlerts: d.geofenceAlerts || [],
          codingAlerts:   d.codingAlerts   || [],
          codingWarnings: codingWarningsOut(d.codingWarnings),
          holidays,
        };
      }));
    } catch (lookupErr) {
      console.error("[GPS] getCarTraceback session lookup error:", lookupErr.message);
      // Non-fatal — traceback still returns points, just without zone/alert/session data.
    }

    // Legacy single-trip fields = the newest trip on this date.
    const latest = sessions[sessions.length - 1] || null;

    return res.json({
      status: "ok",
      data: {
        carId, date, records,
        geofenceZones:  latest?.geofenceZones  || [],
        geofenceAlerts: latest?.geofenceAlerts || [],
        codingAlerts:   latest?.codingAlerts   || [],
        codingWarnings: latest?.codingWarnings || [],
        holidays:       latest?.holidays       || [],
        session:        latest?.session        || null,
        sessions, // every trip touching this date, oldest first
      },
    });
  } catch (err) {
    console.error("[GPS] getCarTraceback error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch traceback." });
  }
};

/**
 * GET /api/gps/:carId/history
 * Every archived (flushed-to-Storage) trip for one car, newest first.
 * Powers Car Tracking's History tab — a session only shows up here once
 * flushBookingHistory (booking.service.js) has flushed it (archiveUrl gets set then), so a
 * car with no completed/flushed trips yet returns an empty list, which the
 * frontend renders as "No GPS record."
 */
export const getCarHistory = async (req, res) => {
  try {
    const { carId } = req.params;
    const sessions = await getSessionsByCar(carId);

    // pointCount = how many GPS points the archived trail holds, so History can
    // show it before anyone clicks Review (see getArchivePointCount in
    // bookingSession.service.js — counted once, then saved on the session).
    const history = await Promise.all(
      sessions
        .filter(({ data }) => !!data.archiveUrl)
        .map(async (session) => { const { data } = session; return ({
          bookingSessionID: data.bookingSessionID,
          bookingID:        data.bookingID || null,
          status:    data.status || null,
          startedAt:        sessionStartedAt(data),
          endedAt:          sessionEndedAt(data), // null while still going
          // Shown on the History list rows so a trip can be told apart without opening its file. Both are
          // already on the session document, so this costs no extra read.
          droppedOffAt:     toIso(data.droppedOffTime),
          stolenAt:         toIso(data.stolenAt),
          archiveUrl:       data.archiveUrl,
          lastArchivedAt:   data.lastArchivedAt || null,
          pointCount:       await getArchivePointCount(session),
        }); })
    );

    // getSessionsByCar already sorts newest-pickup-first, so this list comes
    // out newest-first automatically — no extra sort needed here.
    return res.json({ status: "ok", data: history });
  } catch (err) {
    console.error("[GPS] getCarHistory error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch car history." });
  }
};