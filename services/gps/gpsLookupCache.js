// Small in-memory helpers for the GPS hot path (every tracker ping + every
// map poll). Purpose: stop paying a Firestore read for answers that almost
// never change. On Vercel each warm instance has its own copy, so these are
// best-effort — a cold instance just falls back to the normal Firestore path.

// ── Live locations list (GET /api/gps) ──────────────────────────────────────
const LIVE_TTL_MS = 15_000;
let liveCache = { at: 0, data: null };
let liveInflight = null;

/**
 * Returns the cached list if it's fresh; otherwise runs `loader` once and
 * shares that single Firestore read with every request that arrives while
 * it's in flight. If the loader fails, serves the last good copy if any.
 */
export const getLiveLocationsCached = async (loader) => {
  const now = Date.now();
  if (liveCache.data && now - liveCache.at < LIVE_TTL_MS) return liveCache.data;
  if (liveInflight) return liveInflight;

  liveInflight = (async () => {
    try {
      const data = await loader();
      liveCache = { at: Date.now(), data };
      return data;
    } catch (err) {
      if (liveCache.data) return liveCache.data; // stale beats a 500
      throw err;
    } finally {
      liveInflight = null;
    }
  })();
  return liveInflight;
};

// ── gpsDevice / gpsLocation document lookups (receiveLocation) ──────────────
const DEVICE_TTL_MS = 60_000;
const deviceCache = new Map();  // gpsDeviceID -> { docId|null, carID|null, expires }
const locDocCache = new Map();  // gpsDeviceID -> gpsLocation docId

export const getCachedDevice = (gpsDeviceID) => {
  const hit = deviceCache.get(gpsDeviceID);
  if (hit && Date.now() < hit.expires) return hit;
  return null;
};
export const setCachedDevice = (gpsDeviceID, { docId = null, carID = null } = {}) => {
  deviceCache.set(gpsDeviceID, { docId, carID, expires: Date.now() + DEVICE_TTL_MS });
};
export const getCachedLocDocId = (gpsDeviceID) => locDocCache.get(gpsDeviceID) || null;
export const setCachedLocDocId = (gpsDeviceID, docId) => { locDocCache.set(gpsDeviceID, docId); };
export const clearLocDocId = (gpsDeviceID) => { locDocCache.delete(gpsDeviceID); };

/** Call after any device add/assign/unassign/edit/delete so changes show up immediately. */
export const clearGpsDeviceCaches = () => {
  deviceCache.clear();
  locDocCache.clear();
};

// ── Skip redundant writes for a parked / unchanged tracker ──────────────────
const HEARTBEAT_MS = 60_000;     // always write at least this often
const MOVE_EPSILON_DEG = 0.000045; // ~5 m
const lastWrite = new Map();     // gpsDeviceID -> { lat, lng, speed, offline, at }

/**
 * True when this ping carries no new information (same spot, same speed,
 * live not replayed, written recently) so the Firestore writes can be skipped.
 * Never skips offline-replayed pings, and always writes at the heartbeat.
 */
export const shouldSkipLocationWrite = (gpsDeviceID, lat, lng, speed, offline) => {
  if (offline) return false;
  const prev = lastWrite.get(gpsDeviceID);
  if (!prev) return false;
  if (Date.now() - prev.at >= HEARTBEAT_MS) return false;
  if (prev.offline) return false;
  if (Math.abs(lat - prev.lat) > MOVE_EPSILON_DEG) return false;
  if (Math.abs(lng - prev.lng) > MOVE_EPSILON_DEG) return false;
  if (Math.abs((speed || 0) - (prev.speed || 0)) >= 1) return false;
  return true;
};
export const markLocationWritten = (gpsDeviceID, lat, lng, speed, offline) => {
  lastWrite.set(gpsDeviceID, { lat, lng, speed, offline, at: Date.now() });
};