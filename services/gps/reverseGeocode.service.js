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
//
// SET ONE OF THESE in the backend's environment (Vercel project settings):
//   NOMINATIM_CONTACT_EMAIL   a real contact address, e.g. admin@yourdomain.com  (recommended)
//   NOMINATIM_USER_AGENT      or a full custom User-Agent string
// Nominatim may block requests that do not identify the app, which would leave every coding
// check on the fixed fallback schedule.

const RESOLVED_CACHE_MAX = 5000;          // cells remembered per instance (oldest dropped first)
const FAILED_RETRY_MS = 2 * 60 * 1000;    // a FAILED lookup (network / 4xx / 5xx / timeout) is retried after this
const REQUEST_TIMEOUT_MS = 5000;          // a hung request must not block the queue for every car behind it
const MIN_SPACING_MS = 1100;

// roundKey -> { city: string|null, expires: ms | Infinity }
//   Resolved answers (a city, or "Nominatim answered but has no city here") are kept for good.
//   Failures are kept only FAILED_RETRY_MS so a short outage does not leave a spot "unknown" until the next deploy.
const cache = new Map();
const pending = new Map(); // roundKey -> in-flight Promise, shared across simultaneous pings for the same spot

let queueTail = Promise.resolve();
let warnedNoContact = false;

function roundKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function remember(key, city, ttlMs) {
  cache.delete(key); // re-insert so the oldest-first trim below drops the least recently written
  if (cache.size >= RESOLVED_CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { city, expires: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
}

function userAgent() {
  if (process.env.NOMINATIM_USER_AGENT) return process.env.NOMINATIM_USER_AGENT;
  const contact = process.env.NOMINATIM_CONTACT_EMAIL;
  if (!contact && !warnedNoContact) {
    warnedNoContact = true;
    console.warn("[GEOCODE] NOMINATIM_CONTACT_EMAIL is not set — Nominatim may block anonymous requests, and coding checks would fall back to the fixed schedule.");
  }
  return `ARLTrack-AdminBackend/1.0${contact ? ` (${contact})` : ""}`;
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
 * Caching: a lookup Nominatim ANSWERED (with or without a city) is remembered for the life of the process.
 * A lookup that FAILED (network error, timeout, 403 / 429 / 5xx) is remembered for only FAILED_RETRY_MS, so one
 * bad minute does not leave that spot "unknown" until the next deploy, and a blocked client is not hammered either.
 */
export function reverseGeocodeCity(lat, lng) {
  if (typeof lat !== "number" || typeof lng !== "number") return Promise.resolve(null);
  const key = roundKey(lat, lng);

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.city);
  if (pending.has(key)) return pending.get(key);

  const promise = scheduleCall(() =>
    fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=en`, {
      headers: { "User-Agent": userAgent() },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const a = json?.address || {};
        const city = a.city || a.town || a.municipality || a.county || null;
        remember(key, city, Infinity);
        return city;
      })
      .catch((err) => {
        console.error(`[GEOCODE] lookup failed for ${key} (retry in ${FAILED_RETRY_MS / 1000}s):`, err.message);
        remember(key, null, FAILED_RETRY_MS);
        return null;
      })
      .finally(() => pending.delete(key))
  );

  pending.set(key, promise);
  return promise;
}
