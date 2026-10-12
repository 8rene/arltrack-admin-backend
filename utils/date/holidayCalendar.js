import admin from "firebase-admin";
import { phtDateFromInstant } from "./phtDate.js";

// Monday-first, matching ISO weekday numbering (Mon=1 ... Sun=7) and how
// the codingRules collection names days.
export const DAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

const PHT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── "YYYY-MM-DD" <-> Firestore Timestamp ─────────────────────────────────────
//
// Existing `holidays` docs store holidayDate as midnight Manila time
// (e.g. 2026-04-03T16:00:00Z for April 4). Every write below keeps that
// exact convention, and every read converts back via the PHT calendar date,
// so the admin UI never shows a holiday a day early/late no matter what
// timezone the server runs in.

/** Parses "YYYY-MM-DD" into { y, m, d } or null if it isn't a real calendar date. */
export const parseYmd = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null; // e.g. 2026-02-30 rolls over — reject it
  }
  return { y, m, d };
};

export const ymdToTimestamp = (ymd) => {
  const p = parseYmd(ymd);
  if (!p) throw new Error(`Invalid date "${ymd}".`);
  return admin.firestore.Timestamp.fromMillis(Date.UTC(p.y, p.m - 1, p.d) - PHT_OFFSET_MS);
};

export const timestampToYmd = (ts) => {
  if (!ts || typeof ts.toDate !== "function") return null;
  return phtDateFromInstant(ts.toDate());
};

/** Weekday name ("Saturday") for a "YYYY-MM-DD" calendar date. */
export const weekdayName = (ymd) => {
  const p = parseYmd(ymd);
  if (!p) return "";
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() || 7; // Sun 0 -> 7
  return DAY_NAMES[wd - 1];
};

const pad = (n) => String(n).padStart(2, "0");
const fmtYmd = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const utcDate = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const minusDays = (date, n) => new Date(date.getTime() - n * DAY_MS);

// ── Movable holidays ─────────────────────────────────────────────────────────

/**
 * Easter Sunday for `year` (Gregorian), via the Meeus/Jones/Butcher
 * algorithm. Every Holy Week date is a fixed offset from this — their
 * month/day moves every year, only the weekday stays put.
 */
const easterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  const month = Math.floor(n / 31);
  const day = (n % 31) + 1;
  return utcDate(year, month, day);
};

/** Last `weekday` (Mon=1 ... Sun=7) of `month` (1-12) — how National Heroes Day is defined. */
const lastWeekdayOf = (year, month, weekday) => {
  const lastOfMonth = utcDate(year, month + 1, 0); // day 0 of next month = last day of this one
  const lastWd = lastOfMonth.getUTCDay() || 7;
  const back = (((lastWd - weekday) % 7) + 7) % 7;
  return minusDays(lastOfMonth, back);
};

/**
 * Looks `holidayName` up against the Philippine holidays whose date moves
 * every year by a known rule and returns that year's date as "YYYY-MM-DD",
 * or null if the name isn't one of them (caller falls back to a plain
 * same-month/day shift).
 *
 * Covered: Holy Week (Ash Wednesday, Palm Sunday, Maundy Thursday, Good
 * Friday, Black Saturday, Easter Sunday) and National Heroes Day.
 * NOT covered — no calendar rule exists, they're set by yearly proclamation
 * or moon-sighting: Chinese New Year, Eid al-Fitr, Eid al-Adha. Those keep
 * the same-month/day fallback and need a manual correction each year.
 */
export const movableHolidayDate = (holidayName, year) => {
  const n = String(holidayName || "").trim().toLowerCase();
  if (!n) return null;

  if (n.includes("black saturday") || n.includes("holy saturday")) return fmtYmd(minusDays(easterSunday(year), 1));
  if (n.includes("good friday")) return fmtYmd(minusDays(easterSunday(year), 2));
  if (n.includes("maundy thursday") || n.includes("holy thursday")) return fmtYmd(minusDays(easterSunday(year), 3));
  if (n.includes("palm sunday")) return fmtYmd(minusDays(easterSunday(year), 7));
  if (n.includes("ash wednesday")) return fmtYmd(minusDays(easterSunday(year), 46));
  if (n.includes("easter")) return fmtYmd(easterSunday(year));
  if (n.includes("national heroes day") || n.includes("araw ng mga bayani")) {
    return fmtYmd(lastWeekdayOf(year, 8, 1)); // last Monday of August
  }
  return null;
};

/**
 * Where a holiday currently on `currentYmd` lands when retraced onto `year`:
 * the movable-holiday rule if its name matches one, otherwise the same
 * month/day clamped to that month's last valid day (Feb 29 -> Feb 28 on a
 * non-leap year).
 */
export const retraceDate = (holidayName, currentYmd, year) => {
  const movable = movableHolidayDate(holidayName, year);
  if (movable) return movable;
  const p = parseYmd(currentYmd);
  if (!p) return null;
  const lastDayOfMonth = utcDate(year, p.m + 1, 0).getUTCDate();
  return `${year}-${pad(p.m)}-${pad(Math.min(p.d, lastDayOfMonth))}`;
};
