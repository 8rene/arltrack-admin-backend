// ---------------------------------------------
// codingRules/{ruleID} — Firestore collection
// ---------------------------------------------
// The Number Coding (UVVRP) restrictions, ONE DOC PER RULE: a single city + a
// single weekday + a single time window + the plate digits banned in it.
// Managed from the admin's Coding Restrictions page (services/codingRules/
// codingRules.service.js); READ by the customer backend at booking time and by
// the admin's live GPS check (services/gps/coding.service.js).
//
// A city is NOT its own document — it exists only through the rules that carry
// its name. So: a new city is created with its first rules (at least
// MIN_RULES_PER_NEW_CITY = 5, in one batch), renaming a city rewrites `city`
// on every rule, and deleting a city deletes all of its rules. `city` can't be
// edited on a single existing rule.
//
// Booking-time warnings keep a copy of the rule, not a live link:
// bookingSessions.codingWarnings[] copies city / dayOfWeek / startTime / endTime and
// stores this doc's ID as codingRulesID only as a trace. Editing or deleting a rule
// here never changes what an old booking was warned about.
//
// This is a plain shape, same convention as models/car/car.model.js — no
// Firestore calls here.
export const CodingRule = {
  ruleID: "",         // mirrors this doc's own Firestore ID (random, assigned on create)
  city: "",           // e.g. "Manila", "Quezon City". Free text, trimmed; same spelling on every rule of that city
  dayOfWeek: 1,       // 1 = Monday … 7 = Sunday
  dayName: "",        // "Monday" … "Sunday" — kept in step with dayOfWeek
  startTime: "",      // "7:00 AM" — h:mm AM/PM, upper-case meridiem
  endTime: "",        // "8:00 PM" — same format; must be after startTime. (Older docs may carry "08:00 PM" or a trailing newline; the service trims on read.)
  bannedDigits: [],   // plate LAST digits restricted in this window, e.g. [1, 2] or [9, 0]
};