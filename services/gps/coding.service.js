// Ported from the test backend's helpers.js — the fixed, universal MMDA
// UVVRP ("number coding") rule: last plate digit → one restricted weekday,
// restricted during two fixed daily windows (7-10 AM, 5-8 PM), Mon-Fri.
//
// IMPORTANT DISCREPANCY WORTH KNOWING ABOUT: the customer backend's booking
// -time check (bookings.controller.js) uses a DIFFERENT, more flexible
// system — a Firestore "codingRules" collection with per-rule city, day,
// and custom time windows, checked against the booking's destination city.
// That version could in principle model city-specific or non-standard
// rules; this fixed version can't.
//
// This file intentionally uses the FIXED version anyway, because a live,
// per-GPS-ping check needs an instant answer with no I/O — the Firestore
// version requires a city, and resolving "which city is this lat/lng in"
// live would mean reverse-geocoding every ping (an external API call this
// stack doesn't have anywhere yet). The fixed MMDA schedule needs only the
// plate number, which is already known and cached.
//
// Net effect: a booking could pass the (more flexible) booking-time check
// but still trip this (fixed) live check, or vice versa, if your codingRules
// documents ever diverge from the standard MMDA schedule. If codingRules is
// meant to be the single source of truth going forward, this file should be
// revisited once a geocoding step exists — flagging that now rather than
// silently picking one system as "correct."

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
