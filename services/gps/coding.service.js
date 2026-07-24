// Ported from the test backend's helpers.js — the fixed, universal MMDA
// UVVRP ("number coding") rule: last plate digit → one restricted weekday,
// restricted during two fixed daily windows (7-10 AM, 5-8 PM), Mon-Fri.
//
// UPDATE: this used to be the ONLY live-ping check, because live pings had
// no way to know which city a car was in — resolving that would've meant
// reverse-geocoding every ping, an external API call this stack didn't have
// anywhere. That's no longer true (see reverseGeocode.service.js), so
// resolveCodingRestriction() below now does the same thing the customer
// backend's booking-time check does (Firestore "codingRules" — per-rule
// city, day, custom time windows, holiday suspension) using the ping's
// *actual current* city, and only falls back to this fixed rule if the
// geocode lookup itself fails (network hiccup) — so a car is never simply
// un-checked because Nominatim had a bad moment.
//
// isCodingRestricted (the original fixed function) is kept below exactly
// as it was, purely as that fallback.

const codingDayForPlate = (plateNumber) => {
  if (!plateNumber) return null;
  const digits = String(plateNumber).replace(/\D/g, "");
  if (!digits.length) return null;
  const lastDigit = Number(digits[digits.length - 1]);
  if ([1, 2].includes(lastDigit)) return 1; // Mon
  if ([3, 4].includes(lastDigit)) return 2; // Tue
  if ([5, 6].includes(lastDigit)) return 3; // Wed
  if ([7, 8].includes(lastDigit)) return 4; // Thu
  if ([9, 0].includes(lastDigit)) return 5; // Fri
  return null;
};

/**
 * @param {string} plateNumber
 * @param {Date} atInstant defaults to now
 * @param {boolean} codingSuspended manual override (holiday/typhoon/etc.)
 * @returns { restricted: boolean, reason: string }
 */
export const isCodingRestricted = (plateNumber, atInstant = new Date(), codingSuspended = false) => {
  if (codingSuspended) return { restricted: false, reason: "suspended" };

  const day = codingDayForPlate(plateNumber);
  if (day === null) return { restricted: false, reason: "no-plate-digit" };

  // Evaluate on the Manila wall clock, not server/UTC time.
  const phtMs = atInstant.getTime() + 8 * 60 * 60 * 1000;
  const pht = new Date(phtMs);
  const weekday = pht.getUTCDay();
  const hour = pht.getUTCHours();
  const minute = pht.getUTCMinutes();
  const hm = hour + minute / 60;

  if (weekday !== day) return { restricted: false, reason: "not-coding-day" };

  const inMorningWindow = hm >= 7 && hm < 10;
  const inEveningWindow = hm >= 17 && hm < 20;

  if (inMorningWindow || inEveningWindow) {
    return { restricted: true, reason: inMorningWindow ? "morning-window" : "evening-window" };
  }
  return { restricted: false, reason: "window-hours" };
};

// ── City + Firestore "codingRules" based check (the real, live version) ────

import { db } from "../../config/firebaseConnection/firebase.js";
import { reverseGeocodeCity } from "./reverseGeocode.service.js";

// Same shared-cache idea the customer backend's bookings.controller.js uses
// for its own copy of this collection — rules change rarely, so refetching
// on every single GPS ping would be pure waste. TTL (rather than "once and
// never again," like that controller's process-lifetime cache) because this
// service runs continuously for as long as the process lives, not per-request.
let rulesCache = null;
let rulesCacheAt = 0;
const RULES_TTL_MS = 5 * 60 * 1000;

async function getCodingRules() {
  const now = Date.now();
  if (rulesCache && now - rulesCacheAt < RULES_TTL_MS) return rulesCache;
  const snap = await db.collection("codingRules").get();
  rulesCache = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  rulesCacheAt = now;
  return rulesCache;
}

// Same holiday check as the customer backend's booking-time path — a public
// holiday suspends coding entirely for that calendar day.
async function isHolidayAt(atInstant) {
  const dayStart = new Date(atInstant); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(atInstant); dayEnd.setHours(23, 59, 59, 999);
  const snap = await db.collection("holidays")
    .where("holidayDate", ">=", dayStart)
    .where("holidayDate", "<=", dayEnd)
    .limit(1)
    .get();
  return !snap.empty;
}

function parseRuleTime(t) {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (m[3].toUpperCase() === "PM" && h !== 12) h += 12;
  if (m[3].toUpperCase() === "AM" && h === 12) h = 0;
  return h * 60 + mn;
}

function ruleAppliesRightNow(rule, city, lastDigit, atInstant) {
  const ruleDayOfWeek = Number(rule.dayOfWeek);
  if (isNaN(ruleDayOfWeek) || ruleDayOfWeek !== atInstant.getDay()) return false;

  if (rule.city && rule.city.trim() !== "") {
    if (!city || city.toLowerCase().trim() !== rule.city.toLowerCase().trim()) return false;
  }

  const rStart = parseRuleTime(rule.startTime);
  const rEnd   = parseRuleTime(rule.endTime);
  if (rStart === null || rEnd === null) return false;
  const mins = atInstant.getHours() * 60 + atInstant.getMinutes();
  if (mins < rStart || mins >= rEnd) return false;

  let banned = [];
  if (Array.isArray(rule.bannedDigits)) {
    banned = rule.bannedDigits.map(Number).filter((n) => !isNaN(n));
  } else if (rule.bannedDigits !== undefined && rule.bannedDigits !== null) {
    const single = Number(rule.bannedDigits);
    if (!isNaN(single)) banned = [single];
  }
  return banned.includes(lastDigit);
}

/**
 * The city-aware live check: reverse-geocodes (lat, lng) to a real city and
 * matches it against Firestore's codingRules — same source of truth the
 * customer backend's booking-time check uses, instead of the fixed
 * MMDA-only schedule. Returns `restricted: null` (not true/false) when the
 * geocode lookup itself failed, so the caller can tell "confirmed not
 * restricted" apart from "couldn't check" and fall back accordingly.
 *
 * @returns { restricted: boolean|null, reason: string, city?: string|null }
 */
export async function isCodingRestrictedByCity(plateNumber, lat, lng, atInstant = new Date()) {
  const digits = String(plateNumber || "").replace(/\D/g, "");
  if (!digits.length) return { restricted: false, reason: "no-plate-digit" };
  const lastDigit = Number(digits[digits.length - 1]);

  try {
    if (await isHolidayAt(atInstant)) return { restricted: false, reason: "holiday-suspended" };

    const city = await reverseGeocodeCity(lat, lng);
    if (city === null) return { restricted: null, reason: "geocode-unavailable" };

    const rules = await getCodingRules();
    for (const rule of rules) {
      if (ruleAppliesRightNow(rule, city, lastDigit, atInstant)) {
        return { restricted: true, reason: `city-rule:${rule.city || city}`, city };
      }
    }
    return { restricted: false, reason: "no-matching-rule", city };
  } catch (err) {
    // Firestore hiccup (rules/holidays lookup), not a geocode failure —
    // same "couldn't check" signal so the caller falls back consistently.
    return { restricted: null, reason: `check-failed:${err.message}` };
  }
}

/**
 * What livePing.service.js should actually call. Tries the real city-based
 * check first; only drops to the fixed MMDA schedule if that check
 * genuinely couldn't run (geocode/Firestore failure) — never because a
 * city simply had no matching rule (that's a legitimate "not restricted").
 *
 * @param {boolean} codingSuspended manual override (holiday/typhoon/etc.) —
 *   checked up front so it short-circuits before any network calls.
 */
export async function resolveCodingRestriction(plateNumber, lat, lng, atInstant = new Date(), codingSuspended = false) {
  if (codingSuspended) return { restricted: false, reason: "suspended" };

  const byCity = await isCodingRestrictedByCity(plateNumber, lat, lng, atInstant);
  if (byCity.restricted !== null) return byCity;

  const fallback = isCodingRestricted(plateNumber, atInstant, false);
  return { ...fallback, reason: `fallback-fixed-rule:${fallback.reason}` };
}