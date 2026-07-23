import { saveLocation } from "../../services/gps/gps.service.js";
import { processLivePing } from "../../services/gps/livePing.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import { getSessionsByCar, getActiveSessionByCar } from "../../services/booking/bookingSession.service.js";
import { fetchCarRowsForDate } from "../../services/sheets/sheets.service.js";
import { datesBetweenPHT } from "../../utils/date/phtDate.js";
import admin from "firebase-admin";

/** POST /api/gps  — GPS device pushes a live location */
export const receiveLocation = async (req, res) => {
  const { device_id, lat, lng } = req.body;
  if (!device_id || lat == null || lng == null) {
    return res.status(400).json({ status: "error", message: "device_id, lat, lng required." });
  }

  let data;
  try {
    data = await saveLocation(device_id, lat, lng);
  } catch (err) {
    console.error("[GPS] saveLocation failed:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to save location." });
  }

  try {
    const deviceSnap = await db.collection("gpsDevice")
      .where("gpsDeviceID", "==", device_id).limit(1).get();

    if (!deviceSnap.empty) {
      await deviceSnap.docs[0].ref.update({
        lastLocation: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const assignedCarID = deviceSnap.docs[0].data().carID;
      if (assignedCarID) {
        processLivePing(assignedCarID, parseFloat(lat), parseFloat(lng)).catch((err) =>
          console.error("[GPS] processLivePing failed (raw ping was still saved):", err.message)
        );
      }
    }

    const locSnap = await db.collection("gpsLocation")
      .where("gpsDeviceID", "==", device_id).limit(1).get();

    if (!locSnap.empty) {
      await locSnap.docs[0].ref.update({
        latitude:   parseFloat(lat),
        longtitude: parseFloat(lng), // preserving existing typo in DB
        updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      await db.collection("gpsLocation").add({
        gpsDeviceID: device_id,
        latitude:    parseFloat(lat),
        longtitude:  parseFloat(lng), // preserving existing typo in DB
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[GPS] Firestore update failed:", err.message);
  }

  return res.json({ status: "ok", data });
};

/** GET /api/gps/:id  — Frontend reads one device's location from Firestore */
export const getDeviceLocation = async (req, res) => {
  try {
    const deviceId = req.params.id;

    const locSnap = await db.collection("gpsLocation")
      .where("gpsDeviceID", "==", deviceId).limit(1).get();

    if (!locSnap.empty) {
      const doc = locSnap.docs[0].data();
      return res.json({
        deviceId,
        lat:          parseFloat(doc.latitude)   || null,
        lng:          parseFloat(doc.longtitude) || parseFloat(doc.longitude) || null,
        lastLocation: doc.lastLocation || null,
        updatedAt:    doc.updatedAt?.toDate?.()?.toISOString?.() || null,
      });
    }

    const deviceSnap = await db.collection("gpsDevice")
      .where("gpsDeviceID", "==", deviceId).limit(1).get();

    if (!deviceSnap.empty) {
      const doc = deviceSnap.docs[0].data();
      const loc = doc.lastLocation;
      if (loc && typeof loc === "object" && loc.latitude && loc.longitude) {
        return res.json({
          deviceId,
          lat:          loc.latitude,
          lng:          loc.longitude,
          lastLocation: null,
          updatedAt:    doc.updatedAt?.toDate?.()?.toISOString?.() || null,
        });
      }
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
    const snap = await db.collection("gpsLocation").get();
    const data = snap.docs
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
          lastLocation: doc.lastLocation || null,
          updatedAt:    doc.updatedAt?.toDate?.()?.toISOString?.() || null,
        };
      })
      .filter(Boolean);

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
        currentPosition:  data.currentPosition || null,
        pickupLocation:   data.pickupLocation || null,
        dropoffLocation:  data.dropoffLocation || null,
      },
    });
  } catch (err) {
    console.error("[GPS] getCarActiveSession error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch car session." });
  }
};

/**
 * PATCH /api/gps/:carId/geofence
 * Body: { zones: [{ label, lat, lng, radius }] } — radius in METERS, matching
 * geofence.service.js's haversine comparison (NOT km — that's the geo-test's
 * convention, not this one). Overwrites the active session's geofenceZones
 * wholesale, so the frontend always sends the full edited list (add/remove/
 * resize all happen client-side first, then one save).
 */
export const updateCarGeofence = async (req, res) => {
  try {
    const { carId } = req.params;
    const { zones } = req.body;

    if (!Array.isArray(zones)) {
      return res.status(400).json({ status: "error", message: "zones must be an array." });
    }
    for (const zone of zones) {
      if (typeof zone.lat !== "number" || typeof zone.lng !== "number" || typeof zone.radius !== "number") {
        return res.status(400).json({ status: "error", message: "Each zone needs numeric lat, lng, and radius (meters)." });
      }
    }

    const session = await getActiveSessionByCar(carId);
    if (!session) {
      return res.status(404).json({ status: "error", message: "This car has no active trip to set a geofence on." });
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
    const { date }  = req.query;

    if (!date) {
      return res.status(400).json({ status: "error", message: "date (YYYY-MM-DD) is required." });
    }

    const rows = await fetchCarRowsForDate(carId, date);

    const records = rows
      .filter((r) => typeof r.lat === "number" && typeof r.lng === "number" && r.at)
      .map((r) => ({ lat: r.lat, lng: r.lng, at: r.at }))
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    // Geofence-breach / coding-restriction banner needs the zones + alert
    // logs for whichever session actually spans this date — records above
    // come straight from Sheets with no session context, so we look up the
    // session separately here rather than change how records are sourced.
    let geofenceZones = [];
    let geofenceAlerts = [];
    let codingAlerts = [];
    try {
      const sessions = await getSessionsByCar(carId);
      const match = sessions.find((s) => {
        const pickup = s.data.pickupTime?.toDate?.() || (s.data.pickupTime ? new Date(s.data.pickupTime) : null);
        if (!pickup) return false;
        const end = s.data.returnTime?.toDate?.() || (s.data.returnTime ? new Date(s.data.returnTime) : new Date());
        return datesBetweenPHT(pickup, end).includes(date);
      });
      if (match) {
        geofenceZones  = match.data.geofenceZones  || [];
        geofenceAlerts = match.data.geofenceAlerts || [];
        codingAlerts   = match.data.codingAlerts   || [];
      }
    } catch (lookupErr) {
      console.error("[GPS] getCarTraceback session lookup error:", lookupErr.message);
      // Non-fatal — traceback still returns points, just without zone/alert data.
    }

    return res.json({ status: "ok", data: { carId, date, records, geofenceZones, geofenceAlerts, codingAlerts } });
  } catch (err) {
    console.error("[GPS] getCarTraceback error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch traceback." });
  }
};

/**
 * GET /api/gps/:carId/history
 * Every archived (flushed-to-Storage) trip for one car, newest first.
 * Powers Car Tracking's History tab — a session only shows up here once
 * bookingHistory.service.js has flushed it (archiveUrl gets set then), so a
 * car with no completed/flushed trips yet returns an empty list, which the
 * frontend renders as "No GPS record."
 */
export const getCarHistory = async (req, res) => {
  try {
    const { carId } = req.params;
    const sessions = await getSessionsByCar(carId);

    const history = sessions
      .filter(({ data }) => !!data.archiveUrl)
      .map(({ data }) => ({
        bookingSessionID: data.bookingSessionID,
        bookingID:        data.bookingID || null,
        status:    data.status || null,
        pickupTime:       data.pickupTime || null,
        returnTime:       data.returnTime || null,
        archiveUrl:       data.archiveUrl,
        lastArchivedAt:   data.lastArchivedAt || null,
      }));

    // getSessionsByCar already sorts newest-pickup-first, so this list comes
    // out newest-first automatically — no extra sort needed here.
    return res.json({ status: "ok", data: history });
  } catch (err) {
    console.error("[GPS] getCarHistory error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch car history." });
  }
};