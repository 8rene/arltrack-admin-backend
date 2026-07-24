// Server-side reverse geocoding via Nominatim — resolves "which city is this
// live GPS ping actually in," the missing piece coding.service.js's header
// comment flagged: the fixed MMDA rule was used for live pings specifically
// because no geocoding step existed anywhere in this stack. Now it does.
//
// Mirrors admin-frontend/src/utils/reverseGeocode.js (same cache-by-rounded-
// coordinate + single shared spacing-queue idea, so this process never fires
// more than ~1 request/sec at Nominatim no matter how many cars are pinging),
// but this one runs server-side, so it can set a real identifying User-Agent
// per Nominatim's usage policy — a browser blocks JS from doing that.

const cache = new Map();   // roundKey -> city string | null (null = resolved-but-unknown OR lookup failed)
const pending = new Map(); // roundKey -> in-flight Promise, shared across simultaneous pings for the same spot

let queueTail = Promise.resolve();
const MIN_SPACING_MS = 1100;

function roundKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function scheduleCall(fn) {
  const run = queueTail.then(() => new Promise((resolve) => setTimeout(resolve, MIN_SPACING_MS))).then(fn);
  queueTail = run.catch(() => {}); // one failed lookup shouldn't jam the queue for every car behind it
  return run;
}

/**
 * Resolves { lat, lng } to the raw administrative city/town Nominatim puts
 * it in (e.g. "Makati"), or null if unresolved/failed. Never throws.
 *
 * NOTE: a `null` result is cached for this process's lifetime, same as the
 * frontend version — a car idling in the same spot shouldn't retry every
 * ping. If Nominatim has a brief outage, affected cells stay "unknown"
 * until the next deploy/restart clears the in-memory cache. That's an
 * acceptable trade for not hammering a free public API; if it ever matters
 * in practice, give failed lookups a short TTL instead of caching forever.
 */
export function reverseGeocodeCity(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return Promise.resolve(null);
  const key = roundKey(lat, lng);

  if (cache.has(key)) return Promise.resolve(cache.get(key));
  if (pending.has(key)) return pending.get(key);

  const promise = scheduleCall(() =>
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18`, {
      headers: {
        "User-Agent": "ARLTrack-AdminBackend/1.0 (set a real contact email here before deploying)",
      },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        const a = json?.address || {};
        const city = a.city || a.town || a.municipality || a.county || null;
        cache.set(key, city);
        return city;
      })
      .catch(() => {
        cache.set(key, null);
        return null;
      })
      .finally(() => pending.delete(key))
  );

  pending.set(key, promise);
  return promise;
}