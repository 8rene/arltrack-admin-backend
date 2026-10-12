import { db } from "../../config/firebaseConnection/firebase.js";
import { DAY_NAMES } from "../../utils/date/holidayCalendar.js";

const COLLECTION = "codingRules";
export const MIN_RULES_PER_NEW_CITY = 5;

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// ── Validation (ported from the original Validators) ─────────────────────────

// "7:00 AM" / "08:00 PM" — also tolerates "7:00pm".
const TIME_RE = /^(0?[1-9]|1[0-2]):([0-5][0-9])\s?([AaPp][Mm])$/;

const timeToMinutes = (value) => {
  const m = TIME_RE.exec(String(value || "").trim());
  if (!m) return null;
  const hour12 = Number(m[1]);
  const isPM = m[3].toUpperCase() === "PM";
  return ((hour12 % 12) + (isPM ? 12 : 0)) * 60 + Number(m[2]);
};

// Canonical stored form: "7:00 AM" (single space, upper-case meridiem).
const normalizeTime = (value, label) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw httpError(400, `${label} is required.`);
  const m = TIME_RE.exec(trimmed);
  if (!m) throw httpError(400, `${label}: use h:mm AM/PM format (e.g. 7:00 AM).`);
  return `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
};

// Accepts [1, 2], ["1", "2"] or "1, 2".
const normalizeDigits = (raw) => {
  const parts = Array.isArray(raw)
    ? raw.map((e) => String(e).trim())
    : String(raw ?? "").split(",").map((e) => e.trim());
  const cleaned = parts.filter((e) => e !== "");
  if (cleaned.length === 0) throw httpError(400, "Enter at least one banned digit.");
  const seen = new Set();
  for (const part of cleaned) {
    const n = Number(part);
    if (!/^\d$/.test(part) || !Number.isInteger(n) || n < 0 || n > 9) {
      throw httpError(400, "Banned digits must be single numbers from 0–9.");
    }
    if (seen.has(n)) throw httpError(400, `Digit ${n} is listed more than once.`);
    seen.add(n);
  }
  return [...seen];
};

const normalizeDay = (value) => {
  const idx = DAY_NAMES.findIndex((d) => d.toLowerCase() === String(value ?? "").trim().toLowerCase());
  if (idx === -1) throw httpError(400, "Choose a valid day of the week.");
  return { dayName: DAY_NAMES[idx], dayOfWeek: idx + 1 }; // Monday = 1 ... Sunday = 7
};

/** Validates + normalizes the day/time/digits part of a rule (everything except the city). */
const cleanRule = ({ dayName, startTime, endTime, bannedDigits }) => {
  const day = normalizeDay(dayName);
  const start = normalizeTime(startTime, "Start time");
  const end = normalizeTime(endTime, "End time");
  if (timeToMinutes(end) <= timeToMinutes(start)) {
    throw httpError(400, "End time must be after start time.");
  }
  return { ...day, startTime: start, endTime: end, bannedDigits: normalizeDigits(bannedDigits) };
};

const cleanCity = (value) => {
  const city = String(value ?? "").trim();
  if (!city) throw httpError(400, "Enter a city name.");
  return city;
};

// ── Shape / sort ─────────────────────────────────────────────────────────────

const toDigits = (raw) => {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list.map((e) => Number(String(e).trim())).filter((n) => Number.isInteger(n));
};

const shape = (doc) => {
  const d = doc.data();
  const dayName = (d.dayName || "").trim();
  const dow = Number(d.dayOfWeek);
  return {
    id: doc.id,
    ruleID: d.ruleID || doc.id,
    city: (d.city || "").trim(),
    dayName,
    // Same fallback the original used: dayOfWeek when set (1-7), else derive from dayName.
    dayOfWeek: dow >= 1 && dow <= 7 ? dow : DAY_NAMES.indexOf(dayName) + 1,
    startTime: (d.startTime || "").trim(), // legacy docs can carry a trailing newline
    endTime: (d.endTime || "").trim(),
    bannedDigits: toDigits(d.bannedDigits),
  };
};

const byCityDayTime = (a, b) => {
  const c = a.city.localeCompare(b.city);
  if (c !== 0) return c;
  if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
  return (timeToMinutes(a.startTime) ?? 0) - (timeToMinutes(b.startTime) ?? 0);
};

const fetchAllRules = async () => {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map(shape);
};

// ── Public API ───────────────────────────────────────────────────────────────

export const listCodingRules = async () => {
  const rules = (await fetchAllRules()).sort(byCityDayTime);
  const cities = [...new Set(rules.map((r) => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { cities, rules };
};

/** Adds one rule to a city that already exists (new cities go through createCity). */
export const createRule = async ({ city, ...fields }) => {
  const wanted = cleanCity(city);
  const rule = cleanRule(fields);
  const existing = (await fetchAllRules()).find((r) => r.city.toLowerCase() === wanted.toLowerCase());
  if (!existing) {
    throw httpError(400, `"${wanted}" isn't in the city list yet — add the city first.`);
  }
  const ref = db.collection(COLLECTION).doc();
  await ref.set({ ruleID: ref.id, city: existing.city, ...rule });
  return shape(await ref.get());
};

/**
 * Creates a brand-new city with its first set of rules in one atomic batch
 * (all rules land or none do — a half-created city would otherwise show up
 * with fewer than the required minimum).
 */
export const createCity = async ({ city, rules }) => {
  const name = cleanCity(city);
  if (!Array.isArray(rules) || rules.length < MIN_RULES_PER_NEW_CITY) {
    throw httpError(400, `A new city needs at least ${MIN_RULES_PER_NEW_CITY} coding rules.`);
  }
  const cleaned = rules.map((r, i) => {
    try {
      return cleanRule(r || {});
    } catch (e) {
      throw httpError(400, `Rule ${i + 1}: ${e.message}`);
    }
  });

  const existing = await fetchAllRules();
  if (existing.some((r) => r.city.toLowerCase() === name.toLowerCase())) {
    throw httpError(409, `"${name}" already exists — open it from the city list instead.`);
  }

  const batch = db.batch();
  cleaned.forEach((rule) => {
    const ref = db.collection(COLLECTION).doc(); // every rule gets its own random ID
    batch.set(ref, { ruleID: ref.id, city: name, ...rule });
  });
  await batch.commit();
  return { city: name, created: cleaned.length };
};

export const updateRule = async (id, fields) => {
  const rule = cleanRule(fields);
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Coding rule not found.");
  await ref.update(rule); // city is deliberately not editable on an existing rule
  return shape(await ref.get());
};

export const deleteRule = async (id) => {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Coding rule not found.");
  const removed = shape(snap);
  await ref.delete();
  return removed;
};
