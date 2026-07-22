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
