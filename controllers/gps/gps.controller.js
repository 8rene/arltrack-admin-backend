import { saveLocation, getLocation, getAllLocations } from "../../services/gps/gps.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

/** POST /api/gps  — GPS device pushes a live location */
export const receiveLocation = async (req, res) => {
  const { device_id, lat, lng } = req.body;
  if (!device_id || lat == null || lng == null) {
    return res.status(400).json({ status: "error", message: "device_id, lat, lng required." });
  }

  const data = await saveLocation(device_id, lat, lng); // keep in-memory

  try {
    // Update gpsDevice collection
    const deviceSnap = await db.collection("gpsDevice")
      .where("gpsDeviceID", "==", device_id).limit(1).get();

    if (!deviceSnap.empty) {
      await deviceSnap.docs[0].ref.update({
        lastLocation: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Upsert gpsLocation collection
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

    // Try gpsLocation collection first
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

    // Fallback: check gpsDevice.lastLocation
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
    const snap = await db.collection("gpsDevice").orderBy("gpsName").get();
    const devices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

/** PUT /api/gps/devices/:id/assign  — Assign a car to a GPS device */
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

    return res.json({ status: "ok", message: "Car assigned to GPS device." });
  } catch (err) {
    console.error("[GPS] assignCarToDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to assign car." });
  }
};
