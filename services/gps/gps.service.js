// ── GPS Service ───────────────────────────────────────────────────────────────
// Keeps the latest location per device in memory, so the ping handler gets a normalised record back.
//
// The `gpsLocations` Firestore collection (the one the live map reads) is written by gps.controller.js, not here.
// This service used to write a second copy of every ping, which was a duplicate write and has been removed.

// In-memory cache of the last record per device
const cache = {};

/** Normalise one ping into a location record and remember it. */
export const saveLocation = async (deviceId, lat, lng, recordedAt = new Date()) => {
  const record = {
    deviceId,
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    updatedAt: recordedAt.toISOString(), // the tracker's real GNSS time, not receive time
  };
  cache[deviceId] = record;
  return record;
};

/** Return one device's location (from cache) */
export const getLocation = (deviceId) => cache[deviceId] || null;

/** Return ALL locations seen since this server instance started */
export const getAllLocations = () => Object.values(cache);