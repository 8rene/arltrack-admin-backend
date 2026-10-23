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
    // Snapshot of the fixed MMDA rule that applied, same shape as a city rule
    // (id: null — it isn't a Firestore rule), so history can show what fired.
    const digits = [[1, 2], [3, 4], [5, 6], [7, 8], [9, 0]][day - 1];
    return {
      restricted: true,
      reason: inMorningWindow ? "morning-window" : "evening-window",
      rule: {
        id: null,
        day: DAY_NAMES[day - 1],
        start: inMorningWindow ? "7:00 AM" : "5:00 PM",
        end:   inMorningWindow ? "10:00 AM" : "8:00 PM",
        digits,
      },
    };
  }
  return { restricted: false, reason: "window-hours" };
};

// ── City + Firestore "codingRules" based check (the real, live version) ────

import { db } from "../../config/firebaseConnection/firebase.js";
import { reverseGeocodeCity } from "./reverseGeocode.service.js";
import { DAY_NAMES } from "../../utils/date/holidayCalendar.js";

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

// Manila (PHT, UTC+8) wall clock for an instant. The server runs on UTC, so
// getDay()/getHours() must never be used for rule matching — they would be
// 8 hours off. Everything here derives day/time from this instead.
const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const phtParts = (atInstant) => {
  const p = new Date(atInstant.getTime() + PHT_OFFSET_MS);
  return {
    dow: p.getUTCDay() || 7,                          // Mon=1 ... Sun=7 (same as codingRules)
    minutes: p.getUTCHours() * 60 + p.getUTCMinutes(),
    y: p.getUTCFullYear(), m: p.getUTCMonth(), d: p.getUTCDate(),
  };
};
const pad2 = (n) => String(n).padStart(2, "0");

// Same holiday check as the customer backend's booking-time path — a public
// holiday suspends coding entirely for that calendar day. `holidays` docs
// store holidayDate as midnight MANILA time, so the day range below is the
// Manila calendar day (not the server's).
// Cached per Manila calendar day (1h TTL so a newly-added holiday is still
// picked up) — this runs on every live ping of a car on a trip, and the
// answer only changes at most once a day.
// Returns { name, date: "YYYY-MM-DD" } when it's a holiday, otherwise null.
const holidayCache = new Map(); // dayStart ms -> { value, at }
const HOLIDAY_TTL_MS = 60 * 60 * 1000;
async function isHolidayAt(atInstant) {
  const { y, m, d } = phtParts(atInstant);
  const dayStartMs = Date.UTC(y, m, d) - PHT_OFFSET_MS;
  const hit = holidayCache.get(dayStartMs);
  if (hit && Date.now() - hit.at < HOLIDAY_TTL_MS) return hit.value;

  const snap = await db.collection("holidays")
    .where("holidayDate", ">=", new Date(dayStartMs))
    .where("holidayDate", "<=", new Date(dayStartMs + DAY_MS - 1))
    .limit(1)
    .get();
  const value = snap.empty ? null : {
    name: snap.docs[0].data().holidayName || "",
    date: `${y}-${pad2(m + 1)}-${pad2(d)}`,
  };
  if (holidayCache.size > 30) holidayCache.clear();
  holidayCache.set(dayStartMs, { value, at: Date.now() });
  return value;
}

/**
 * Every holiday on a Manila calendar day within [start, end] — saved into a
 * trip's history file so a trip can be reviewed later with the holidays that
 * were in effect. One query per history save (not per ping).
 * @returns {Promise<{date: string, name: string}[]>} sorted by date
 */
export async function getHolidaysBetween(start, end) {
  const a = phtParts(start), b = phtParts(end);
  const fromMs = Date.UTC(a.y, a.m, a.d) - PHT_OFFSET_MS;
  const toMs   = Date.UTC(b.y, b.m, b.d) - PHT_OFFSET_MS + DAY_MS - 1;
  const snap = await db.collection("holidays")
    .where("holidayDate", ">=", new Date(fromMs))
    .where("holidayDate", "<=", new Date(toMs))
    .get();
  return snap.docs
    .map((doc) => {
      const raw = doc.data();
      const t = raw.holidayDate?.toDate ? raw.holidayDate.toDate() : null;
      if (!t) return null;
      const p = phtParts(t);
      return { date: `${p.y}-${pad2(p.m + 1)}-${pad2(p.d)}`, name: raw.holidayName || "" };
    })
    .filter(Boolean)
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
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

// codingRules store dayOfWeek as Mon=1 ... Sun=7. Legacy docs without a usable
// number fall back to the day NAME (same fallback codingRules.service uses).
const ruleDay = (rule) => {
  const n = Number(rule.dayOfWeek);
  if (n >= 1 && n <= 7) return n;
  const idx = DAY_NAMES.findIndex((x) => x.toLowerCase() === String(rule.dayName || "").trim().toLowerCase());
  return idx === -1 ? NaN : idx + 1;
};

const bannedOf = (rule) => {
  let banned = [];
  if (Array.isArray(rule.bannedDigits)) {
    banned = rule.bannedDigits.map(Number).filter((n) => !isNaN(n));
  } else if (rule.bannedDigits !== undefined && rule.bannedDigits !== null) {
    const single = Number(rule.bannedDigits);
    if (!isNaN(single)) banned = [single];
  }
  return banned;
};

function ruleAppliesRightNow(rule, city, lastDigit, atInstant) {
  const { dow, minutes } = phtParts(atInstant);
  if (ruleDay(rule) !== dow) return false;

  if (rule.city && rule.city.trim() !== "") {
    if (!city || city.toLowerCase().trim() !== rule.city.toLowerCase().trim()) return false;
  }

  const rStart = parseRuleTime(rule.startTime);
  const rEnd   = parseRuleTime(rule.endTime);
  if (rStart === null || rEnd === null) return false;
  if (minutes < rStart || minutes >= rEnd) return false;

  return bannedOf(rule).includes(lastDigit);
}

// The rule as it was when it fired — saved on the alert so history doesn't
// depend on whatever the codingRules say later.
const ruleSnapshot = (rule) => ({
  id: rule.ruleID || rule.id || null,
  city: rule.city || null,
  day: rule.dayName || DAY_NAMES[ruleDay(rule) - 1] || null,
  start: String(rule.startTime || "").trim(),
  end: String(rule.endTime || "").trim(),
  digits: bannedOf(rule),
});

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

  // The holiday lookup is its own step. If it can't run we can't tell whether
  // coding is suspended today, so we say "unknown" (restricted: null +
  // holidayUnknown) and the caller leaves the state alone -- instead of falling
  // back to the fixed rule, which doesn't know about holidays and could raise a
  // false restriction on a holiday.
  let holiday;
  try {
    holiday = await isHolidayAt(atInstant);
  } catch (err) {
    return { restricted: null, reason: `holiday-check-failed:${err.message}`, holidayUnknown: true };
  }
  if (holiday) return { restricted: false, reason: "holiday-suspended", holiday };

  try {
    const city = await reverseGeocodeCity(lat, lng);
    if (city === null) return { restricted: null, reason: "geocode-unavailable" };

    const rules = await getCodingRules();
    for (const rule of rules) {
      if (ruleAppliesRightNow(rule, city, lastDigit, atInstant)) {
        return { restricted: true, reason: `city-rule:${rule.city || city}`, city, rule: ruleSnapshot(rule) };
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
  // Holiday status unknown -> don't guess with the fixed rule (it ignores holidays).
  if (byCity.holidayUnknown) return byCity;

  const fallback = isCodingRestricted(plateNumber, atInstant, false);
  return { ...fallback, reason: `fallback-fixed-rule:${fallback.reason}` }; // keeps fallback.rule when restricted
}


/**
 * A plate with the middle hidden, for records that outlive the trip (and for the public history file):
 * first character, one * per hidden character, last character -- "PAB1232" -> "P*****2". The last digit is what
 * number coding is decided by, so the record still shows which plate ending the rule applied to. null if the
 * plate is unknown or too short to mask.
 */
export const maskPlate = (plate) => {
  const p = String(plate || "").replace(/[\s-]/g, "");
  if (p.length < 2) return null;
  return p[0] + "*".repeat(Math.max(p.length - 2, 1)) + p[p.length - 1];
};