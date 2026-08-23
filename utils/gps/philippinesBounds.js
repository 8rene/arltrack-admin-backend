// A plain numeric bounding box around the Philippines, used as a cheap,
// instant sanity check on incoming GPS pings — no network call, no
// dependency on the rate-limited reverse-geocode queue used elsewhere for
// coding-restriction lookups (see services/gps/reverseGeocode.service.js,
// throttled to ~1 req/sec across the whole fleet — far too slow to gate
// every single ping through).
//
// This is a rectangle, not the country's actual (archipelago) outline, so
// it's a loose approximation — it also covers open ocean, a slice of
// Malaysia (Sabah), and the southern tip of Taiwan. That's an accepted
// trade-off: the goal is catching wildly-wrong fixes (a bad GPS chip
// reporting a point on another continent, another hemisphere, or "null
// island" 0,0), not perfectly excluding every non-PH point. A ping that
// lands inside this box but not actually on Philippine soil/water would
// still pass — see the conversation this was built from for the reasoning.
const PH_BOUNDS = {
  minLat: 4,
  maxLat: 21.5,
  minLng: 116,
  maxLng: 127,
};

/**
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean} true if the point falls within the Philippines bounding box
 */
export function isWithinPhilippines(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
    return false;
  }
  return (
    lat >= PH_BOUNDS.minLat &&
    lat <= PH_BOUNDS.maxLat &&
    lng >= PH_BOUNDS.minLng &&
    lng <= PH_BOUNDS.maxLng
  );
}

export { PH_BOUNDS };