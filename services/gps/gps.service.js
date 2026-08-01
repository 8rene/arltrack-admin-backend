// ── GPS Service ───────────────────────────────────────────────────────────────
// Stores the latest GPS location for every car that has ever had one applied.
// Uses an in-memory map as a fast cache AND persists to Firestore so locations
// survive server restarts and are visible across multiple server instances.
//
// Firestore collection: "gpsLocations"
//   Document ID  : deviceId  (the car's Firestore document ID)
//   Fields       : deviceId, lat, lng, updatedAt (ISO string)

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// In-memory cache so reads are instant (no Firestore round-trip on every poll)
const cache = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write one location to Firestore + update cache */
export const saveLocation = async (deviceId, lat, lng, recordedAt = new Date()) => {
  const record = {
    deviceId,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    updatedAt: recordedAt.toISOString(), // the tracker's real GNSS time, not receive time
  };

  // Update in-memory cache immediately
  cache[deviceId] = record;

  // Persist to Firestore using admin SDK
  try {
    await db.collection("gpsLocations").doc(deviceId).set(
      { ...record, savedAt: admin.firestore.Timestamp.fromDate(recordedAt) },
      { merge: true }
    );
  } catch (err) {
    console.error("[GPS] Firestore write failed:", err.message);
  }

  return record;
};

/** Return one device's location (from cache) */
export const getLocation = (deviceId) => cache[deviceId] || null;

/** Return ALL locations that have ever been applied */
export const getAllLocations = () => Object.values(cache);

/**
 * Seed the in-memory cache from Firestore on startup.
 * Call once from index.js after the server starts.
 */
export const seedCacheFromFirestore = async () => {
  try {
    const snap = await db.collection("gpsLocations").get();
    snap.forEach((d) => {
      const data = d.data();
      cache[data.deviceId] = {
        deviceId:  data.deviceId,
        lat:       data.lat,
        lng:       data.lng,
        updatedAt: data.updatedAt,
      };
    });
    console.log(`[GPS] Cache seeded with ${snap.size} location(s) from Firestore`);
  } catch (err) {
    console.error("[GPS] Failed to seed cache from Firestore:", err.message);
  }
};