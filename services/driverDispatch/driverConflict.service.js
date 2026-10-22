// Driver schedule rules + the database checks built on them, in one place.
//
// PART 1 (pure, no database): what counts as a clash between two trips for one driver.
//   A booking's window is when the CUSTOMER has the car. The driver also has to get to the pickup,
//   finish the drop-off and rest, so a driver is treated as busy from the trip's start until
//   `bufferMs` AFTER its end. Two trips for one driver are then either:
//     "overlap"  the actual windows intersect              (a real double booking)
//     "tight"    no intersection, but the gap between them is shorter than the buffer
//                (this also covers trips that merely touch: one ends at 5:00, the next starts at 5:00)
//   A gap of exactly `bufferMs` is fine. The buffer is systemSettings.driverBufferMinutes (default 2 h),
//   the same value the customer backend uses for its "is a driver still available" check.
//
// PART 2 (database): loading the driver's trips, the buffer setting, the wording
//   of a clash, and the guard for date edits.
//
// Imports no booking/dispatch service, so booking.service.js (date edits) and
// driverDispatch.service.js (assigning) can both use it without a circular import.
import { db } from "../../config/firebaseConnection/firebase.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";
import {
  ASSIGNMENT_STATUS, bookingKeyOf, getActiveAssignment, getAssignmentsForDriver, getBookingsByKeys,
} from "../driverAssignments/driverAssignments.service.js";

// ─────────────────────────────────────────────
// PART 1 — pure rules
// ─────────────────────────────────────────────
export const DEFAULT_DRIVER_BUFFER_MINUTES = 120;
export const OVERRIDE_REASON_MIN_LENGTH = 5; // an overlap override must come with a real reason

export const toDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
};

// An ongoing trip that runs past its scheduled end keeps its driver busy until the car actually
// comes back, so for scheduling its end is "now" (never earlier than the scheduled end).
export const effectiveEnd = (booking, now = new Date()) => {
  const end = toDate(booking.endDateTime);
  if (end && String(booking.status || "").toLowerCase() === "ongoing" && now > end) return now;
  return end;
};

/**
 * Compare one window against a driver's other live trips.
 *
 * @param {Array}  driverBookings  the driver's other trips: { id, bookingID, status, startDateTime, endDateTime }
 * @param {object} opts { start, end, bufferMs, excludeDocID, now }
 * @returns {{ worst: object|null, all: object[] }}
 *   Each item: { type: "overlap"|"tight", id, bookingID, startDateTime, endDateTime, gapMinutes }
 *   `worst` is the first overlap if there is one, otherwise the tightest gap.
 */
export const evaluateDriverSchedule = (driverBookings, { start, end, bufferMs, excludeDocID = null, now = new Date() }) => {
  const s = toDate(start);
  const e = toDate(end) || s;
  if (!s || !e) return { worst: null, all: [] };

  const all = [];
  for (const b of driverBookings || []) {
    if (excludeDocID && b.id === excludeDocID) continue;
    const bStart = toDate(b.startDateTime);
    const bEnd = effectiveEnd(b, now);
    if (!bStart || !bEnd) continue;

    const overlap = s < bEnd && e > bStart;
    // Time between the two trips; negative or zero when they intersect or touch.
    const gapMs = Math.max(s.getTime() - bEnd.getTime(), bStart.getTime() - e.getTime());
    const tight = !overlap && gapMs < bufferMs;
    if (!overlap && !tight) continue;

    all.push({
      type: overlap ? "overlap" : "tight",
      id: b.id,
      bookingID: b.bookingID || b.id,
      startDateTime: bStart,
      endDateTime: bEnd,
      gapMinutes: overlap ? 0 : Math.max(0, Math.round(gapMs / 60000)),
    });
  }

  const worst = all.find((c) => c.type === "overlap")
    || all.slice().sort((a, b) => a.gapMinutes - b.gapMinutes)[0]
    || null;
  return { worst, all };
};

// ─────────────────────────────────────────────
// PART 2 — database checks
// ─────────────────────────────────────────────
const MINUTE_MS = 60 * 1000;
const LIVE_STATUSES = ["upcoming", "ongoing"];

/** Minimum gap between two trips for one driver, from System Settings (default 2 hours). */
export const getDriverBufferMinutes = async () => {
  try {
    const mins = Number((await getSystemSettings()).driverBufferMinutes);
    return Number.isFinite(mins) && mins >= 0 ? mins : DEFAULT_DRIVER_BUFFER_MINUTES;
  } catch {
    return DEFAULT_DRIVER_BUFFER_MINUTES;
  }
};

/**
 * The driver's live (upcoming / ongoing) trips as { id, ...booking }, from their "assigned" rows.
 * Pass a Firestore transaction `t` to make the reads part of it.
 */
export const getDriverLiveBookings = async (driverID, t = null) => {
  const assignments = await getAssignmentsForDriver(driverID, [ASSIGNMENT_STATUS.ASSIGNED], t);
  const bookings = await getBookingsByKeys(assignments.map((a) => a.bookingID), t);
  return bookings.filter((b) => LIVE_STATUSES.includes(String(b.status || "").toLowerCase()));
};

const fmtWhen = (d) =>
  d.toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });

const fmtGap = (mins) => {
  if (mins <= 0) return "no time";
  const h = Math.floor(mins / 60), m = mins % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
};

/** Human sentence for one conflict returned by evaluateDriverSchedule. */
export const describeConflict = (c, bufferMinutes) =>
  c.type === "overlap"
    ? `This driver is already assigned to booking ${c.bookingID} from ${fmtWhen(c.startDateTime)} to ${fmtWhen(c.endDateTime)}, which overlaps this trip.`
    : `This driver has booking ${c.bookingID} from ${fmtWhen(c.startDateTime)} to ${fmtWhen(c.endDateTime)}, only ${fmtGap(c.gapMinutes)} apart from this trip (at least ${fmtGap(bufferMinutes)} is needed between trips).`;

/**
 * Date edit on a booking that already has a driver: refuse a change that would give that driver a
 * real overlap. A "tight" gap is allowed (it is only a warning everywhere else too). Throws an Error
 * with the reason; does nothing when the booking has no driver or is not a live chauffeur trip.
 */
export const assertAssignedDriverFreeForNewDates = async ({ docID, bookingData, newStart, newEnd }) => {
  if (bookingData.modeOfDriving !== "With Chauffeur") return;
  if (!LIVE_STATUSES.includes(String(bookingData.status || "").toLowerCase())) return;

  const start = toDate(newStart ?? bookingData.startDateTime);
  const end = toDate(newEnd ?? bookingData.endDateTime);
  if (!start || !end) return;

  const assignment = await getActiveAssignment(bookingKeyOf(docID, bookingData));
  if (!assignment?.driverID) return;

  const bufferMinutes = await getDriverBufferMinutes();
  const others = await getDriverLiveBookings(assignment.driverID);
  const { all } = evaluateDriverSchedule(others, { start, end, bufferMs: bufferMinutes * MINUTE_MS, excludeDocID: docID });
  const overlap = all.find((c) => c.type === "overlap");
  if (overlap) {
    throw new Error(
      `${describeConflict(overlap, bufferMinutes)} Unassign or reassign the driver first, or choose different dates.`
    );
  }
};