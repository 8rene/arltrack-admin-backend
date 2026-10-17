// ── GPS Service ───────────────────────────────────────────────────────────────
// Keeps the latest location per device in memory, so the ping handler gets a normalised record back.
//
// This used to ALSO write every persisted ping to a `gpsLocations` Firestore collection. Nothing ever read that
// collection (the live map reads `gpsLocation`, written by gps.controller.js), so it was a duplicate write on every
// ping and has been removed. If you have an old `gpsLocations` collection, it can be deleted.

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
