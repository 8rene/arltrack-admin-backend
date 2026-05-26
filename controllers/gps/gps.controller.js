import { saveLocation, getLocation, getAllLocations } from "../../services/gps/gps.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

/** POST /api/gps  — GPS device pushes a live location */
export const receiveLocation = async (req, res) => {
  const { device_id, lat, lng } = req.body;
  if (!device_id || lat == null || lng == null) {
    return res.status(400).json({ status: "error", message: "device_id, lat, lng required." });
  }
  const data = await saveLocation(device_id, lat, lng);

  // Also update lastLocation in gpsLocation collection if this device exists
  try {
    const snap = await db.collection("gpsLocation").where("gpsLocationID", "==", device_id).limit(1).get();
    if (!snap.empty) {
      await snap.docs[0].ref.update({
        lastLocation: {
          latitude:  parseFloat(lat),
          longitude: parseFloat(lng),
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } catch (err) {
    console.error("[GPS] gpsLocation update failed:", err.message);
  }

  return res.json({ status: "ok", data });
};

/** GET /api/gps/:id  — Frontend reads one device */
export const getDeviceLocation = (req, res) => {
  const data = getLocation(req.params.id);
  return res.json(data || {});
};

/** GET /api/gps  — Frontend reads ALL devices that have a stored location */
export const getAllDeviceLocations = (req, res) => {
  return res.json({ status: "ok", data: getAllLocations() });
};

/** GET /api/gps/devices  — Get all GPS devices from gpsLocation collection */
export const getAllGpsDevices = async (req, res) => {
  try {
    const snap = await db.collection("gpsLocation").orderBy("gpsName").get();
    const devices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ status: "ok", data: devices });
  } catch (err) {
    console.error("[GPS] getAllGpsDevices error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to fetch GPS devices." });
  }
};

/** POST /api/gps/devices  — Add a new GPS device */
export const addGpsDevice = async (req, res) => {
  try {
    // Get count to auto-name the device
    const snap  = await db.collection("gpsLocation").get();
    const count = snap.size + 1;

    const docRef = db.collection("gpsLocation").doc();
    await docRef.set({
      gpsLocationID: docRef.id,
      gpsName:       `GPS ${count}`,
      carID:         "",
      lastLocation: {
        latitude:  0,
        longitude: 0,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const newDoc = await docRef.get();
    return res.status(201).json({ status: "ok", data: { id: docRef.id, ...newDoc.data() } });
  } catch (err) {
    console.error("[GPS] addGpsDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to add GPS device." });
  }
};

/** PUT /api/gps/devices/:id  — Assign or unassign a car to a GPS device */
export const updateGpsDevice = async (req, res) => {
  const { id } = req.params;
  const { carID } = req.body;

  try {
    const docRef = db.collection("gpsLocation").doc(id);
    const doc    = await docRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "GPS device not found." });
    }

    await docRef.update({
      carID:     carID || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ status: "ok", message: "GPS device updated." });
  } catch (err) {
    console.error("[GPS] updateGpsDevice error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to update GPS device." });
  }
};
