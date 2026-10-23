// Ported from the test backend's helpers.js haversineDistance — same formula,
// same meters-based radius comparison against a session's geofenceZones
// (each zone: { label, lat, lng, radius } — see the customer backend's
// bookingsession.model.js makeZone()).

const EARTH_RADIUS_METERS = 6371000;

export const haversineDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * A point is "inside" if it falls within ANY one of the session's zones
 * (pickup zone OR dropoff zone OR any custom zone) — a car doesn't need to
 * be at every zone at once, just at least one of the places it's allowed.
 * Breach = outside all of them.
 *
 * @returns { breached: boolean, nearestZone: string|null, distanceMeters: number|null }
 */
export const checkGeofence = (lat, lng, zones = []) => {
  if (!Array.isArray(zones) || zones.length === 0) {
    // No zones configured for this session — nothing to check against.
    return { breached: false, nearestZone: null, distanceMeters: null };
  }

  let nearest = null;
  for (const zone of zones) {
    if (typeof zone.lat !== "number" || typeof zone.lng !== "number") continue;
    const distance = haversineDistanceMeters(lat, lng, zone.lat, zone.lng);
    if (distance <= zone.radius) {
      return { breached: false, nearestZone: zone.label, distanceMeters: Math.round(distance) };
    }
    if (!nearest || distance < nearest.distanceMeters) {
      nearest = { nearestZone: zone.label, distanceMeters: Math.round(distance) };
    }
  }

  return { breached: true, ...nearest };
};

/**
 * How many pings in a row must disagree with the logged state before a
 * breach / cleared entry is written. One stray GPS fix (or a car sitting on a
 * zone's edge) therefore can't raise an alert by itself. Trackers ping every
 * few seconds, so confirming costs a real breach only a few seconds.
 */
export const GEOFENCE_CONFIRM_PINGS = 2;

/**
 * Debounce for geofence transitions. `wasBreached` is the state the log
 * currently says; `breached` is what this ping says.
 *  - same as the log  -> nothing to do, the counter resets to 0
 *  - different        -> count it; once it reaches `required` in a row, it is a real transition
 * @returns {{ transition: boolean, count: number }} count = value to store back on the session
 */
export const nextGeofenceFlip = ({ breached, wasBreached, flipCount = 0, required = GEOFENCE_CONFIRM_PINGS }) => {
  if (breached === wasBreached) return { transition: false, count: 0 };
  const count = (Number(flipCount) || 0) + 1;
  return count >= required ? { transition: true, count: 0 } : { transition: false, count };
};


/**
 * The full geofence transition rule for one ping, as one pure function so it can be tested on its own.
 *  - After drop-off the customer is released: no NEW breach is ever raised. A breach that was still open is
 *    closed (so the Live badge and the bell clear) and tagged afterDropOff so the log says why.
 *  - Otherwise the two-ping rule (nextGeofenceFlip) decides when a breach / cleared entry is written.
 * @returns {{ entry: "breach"|"cleared"|null, afterDropOff?: boolean, count: number }}
 *   count = value to store back as geofenceFlipCount
 */
export const decideGeofence = ({ breached, wasBreached, flipCount = 0, droppedOff = false }) => {
  if (droppedOff) {
    return wasBreached ? { entry: "cleared", afterDropOff: true, count: 0 } : { entry: null, count: 0 };
  }
  const flip = nextGeofenceFlip({ breached, wasBreached, flipCount });
  if (flip.transition) return { entry: breached ? "breach" : "cleared", count: 0 };
  return { entry: null, count: flip.count };
};