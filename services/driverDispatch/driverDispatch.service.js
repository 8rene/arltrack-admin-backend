import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { ROLES, resolveRoleID } from "../../utils/roles/role.util.js";
import { updateBooking, markBookingDroppedOff, resolvePaymentInfo as resolveBookingPaymentInfo } from "../../services/booking/booking.service.js";
import { getSessionByBookingID } from "../../services/booking/bookingSession.service.js";
import { getPhaseChecklist, getVehicleDocsByBooking } from "../../services/vehicleDocumentation/vehicleDocumentation.service.js";
import { getReminderCooldowns, sendInspectionReminder } from "../../services/inspectionReminders/inspectionReminders.service.js";
import { createNotification } from "../../services/notification/notification.service.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { createPenalty, listPenaltiesForDriver, editPenaltyAsDriver } from "../penalty/penalty.service.js";
import { sessionStartedAt } from "../../utils/date/sessionDates.js";
import { getTermsVersion } from "../terms/terms.service.js";
import {
  ASSIGNMENT_STATUS, bookingKeyOf, attachCurrentDrivers, resolveCurrentDriverID, getCompletedAssignment,
  getAssignmentsForDriver, getBookingsByKeys, createAssignment, endActiveAssignment,
  legacyDriverFieldsPatch, getActiveAssignment, markEnRoute,
} from "../driverAssignments/driverAssignments.service.js";
import {
  OVERRIDE_REASON_MIN_LENGTH, effectiveEnd, evaluateDriverSchedule, getDriverBufferMinutes,
  getDriverLiveBookings, describeConflict,
} from "./driverConflict.service.js";

// ─────────────────────────────────────────────
// Helpers (deliberately self-contained rather than importing from
// booking.service.js — those helpers aren't exported, and duplicating
// small resolvers like this per-module is the existing convention here,
// see booking.service.js vs payments.service.js both having their own
// resolveVehicleName/resolveUserInfo).
// ─────────────────────────────────────────────

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const resolveVehicleName = async (carID) => {
  if (!carID) return "—";
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return "—";
    const { modelID } = carDoc.data();
    if (!modelID) return "—";
    const modelDoc = await db.collection("model").doc(modelID).get();
    if (!modelDoc.exists) return "—";
    const { brandID, modelName } = modelDoc.data();
    const brandDoc = await db.collection("brand").doc(brandID).get();
    const brandName = brandDoc.exists ? brandDoc.data().brandName : "";
    return [brandName, modelName].filter(Boolean).join(" ") || "—";
  } catch { return "—"; }
};

// bookingID → { totalFee, amountPaid, balance, payType, paymentStatus } —
// same computeAmounts() logic booking.service.js and payments.service.js
// use, so the driver's My Trips payment modal matches the admin side
// exactly instead of being derived a third, different way (or not at all,
// which is what was happening here before).
const EMPTY_PAYMENT = {
  totalFee: 0, amountPaid: 0, balance: 0, payType: "—", paymentStatus: "—",
  discountAmount: 0, refundDue: 0, refundIssued: false,
  // Deposit / penalty breakdown — populated for the ongoing-trip Payments
  // button; 0/false for a trip with no payment doc yet.
  depositAmount: 0, depositStatus: "—", confirmedPenaltyTotal: 0, amountToReturn: 0,
  depositSettled: false, depositDeducted: 0,
};
const EMPTY_CHECKLIST = { photos: false, parts: false, complete: false };
// The payment / deposit / penalty read is the SAME one the Bookings list uses
// (booking.service.js's resolvePaymentInfo), trimmed to the fields the driver app
// shows. It used to be a second copy of that logic here (including its own
// penalties query), which had to be kept in step by hand.
const resolvePaymentInfo = async (bookingID) => {
  if (!bookingID) return EMPTY_PAYMENT;
  const info = await resolveBookingPaymentInfo(bookingID);
  return Object.fromEntries(Object.keys(EMPTY_PAYMENT).map((k) => [k, info[k] ?? EMPTY_PAYMENT[k]]));
};

const resolveUserInfo = async (userID) => {
  if (!userID) return { name: "—", phone: "—" };
  try {
    const [detailDoc, userDoc] = await Promise.all([
      db.collection("userDetails").doc(userID).get(),
      db.collection("user").doc(userID).get(),
    ]);
    const { firstName = "", lastName = "" } = detailDoc.exists ? detailDoc.data() : {};
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { phone = "—", username = "", email = "" } = userDoc.exists ? userDoc.data() : {};
    return { name: fullName || username || email || "—", phone };
  } catch { return { name: "—", phone: "—" }; }
};

// userID -> "First Last" from userDetails (where names live; the user doc has no
// first/last name). One query per 30 ids instead of two reads per person.
const resolveDisplayNames = async (userIDs) => {
  const map = new Map();
  const ids = [...new Set((userIDs || []).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await db.collection("userDetails")
      .where(admin.firestore.FieldPath.documentId(), "in", ids.slice(i, i + 30))
      .get();
    snap.forEach((doc) => {
      const { firstName = "", lastName = "" } = doc.data();
      const full = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (full) map.set(doc.id, full);
    });
  }
  return map;
};

// Statuses considered "live" for dispatch purposes — a booking that's
// upcoming or already picked up (ongoing) can hold/need a driver.
// completed/cancelled/cancellation_request/stolen bookings are excluded
// entirely: nothing to dispatch, nothing to keep assigned.
const DISPATCHABLE_STATUSES = ["upcoming", "ongoing"];

// ─────────────────────────────────────────────
// Driver's-license status — used to WARN when assigning a driver, not to
// block or lock anyone. (Auto-locking an expired driver also locked them out
// of the very page they need to upload a renewed license, so expiry is now
// surfaced here + on the dashboard + in the bell instead.)
// ─────────────────────────────────────────────
const LICENSE_WARNING_DAYS = 14; // same threshold as the dashboard + nightly job
const DAY_MS = 24 * 60 * 60 * 1000;

const fmtDay = (d) =>
  d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });

// Exact-moment rule (same as the nightly job): expired the instant it passes.
const licenseStatusOf = (expiry, now = Date.now()) => {
  if (!expiry) return { status: "none", daysLeft: null };
  const msLeft = expiry.getTime() - now;
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  if (msLeft < 0) return { status: "expired", daysLeft };
  return { status: daysLeft <= LICENSE_WARNING_DAYS ? "expiring" : "ok", daysLeft };
};

// userID -> current license expiry (Date). A person can have more than one
// userDocument record (old data, re-uploads), so the LATEST expiry wins.
const resolveLicenseExpiries = async (userIDs) => {
  const map = new Map();
  for (let i = 0; i < userIDs.length; i += 30) { // Firestore "in" allows 30 values
    const snap = await db.collection("userDocument").where("userID", "in", userIDs.slice(i, i + 30)).get();
    snap.forEach((doc) => {
      const data = doc.data();
      const expiry = toJSDate(data.driverLicenseExpiry);
      if (!expiry) return;
      const prev = map.get(data.userID);
      if (!prev || expiry > prev) map.set(data.userID, expiry);
    });
  }
  return map;
};

// ─────────────────────────────────────────────
// GET the full dispatch board: every active Driver, their current
// assignments, and every chauffeur booking still waiting for one.
// ─────────────────────────────────────────────
export const getDispatchBoard = async () => {
  const driverRoleID = await resolveRoleID(ROLES.DRIVER);
  if (!driverRoleID) throw new Error("Could not resolve the Driver role ID.");

  const [driverSnap, bookingSnaps] = await Promise.all([
    db.collection("user").where("roleID", "==", driverRoleID).get(),
    Promise.all(
      DISPATCHABLE_STATUSES.map((s) => db.collection("bookings").where("status", "==", s).get())
    ),
  ]);

  // Only chauffeur bookings matter here — self-drive never needs a driver.
  let bookings = [];
  bookingSnaps.forEach((snap) =>
    snap.forEach((doc) => {
      const data = doc.data();
      if (data.modeOfDriving === "With Chauffeur") bookings.push({ id: doc.id, ...data });
    })
  );

  // The current driver now lives in driverAssignments, not on the booking.
  await attachCurrentDrivers(bookings);

  const carIDs  = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];
  const userIDs = [...new Set(bookings.map((b) => b.userID).filter(Boolean))];

  const [vehicleEntries, userEntries] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
  ]);
  const vehicleMap = Object.fromEntries(vehicleEntries);
  const userMap    = Object.fromEntries(userEntries);

  const shapedBookings = bookings
    .map((b) => ({
      id:            b.id,
      bookingID:     b.bookingID || b.id,
      status:        b.status,
      startDateTime: toJSDate(b.startDateTime),
      endDateTime:   toJSDate(b.endDateTime),
      location:      b.location || "—",
      vehicleName:   vehicleMap[b.carID] || "—",
      customerName:  userMap[b.userID]?.name || "—",
      customerPhone: userMap[b.userID]?.phone || "—",
      driverID:      b.driverID || null,
    }))
    .sort((a, b) => (a.startDateTime?.getTime() ?? 0) - (b.startDateTime?.getTime() ?? 0));

  // Per the decided scope: "unassigned" = upcoming only. An "ongoing"
  // chauffeur booking with no driver is a data problem, not a queue item —
  // surface it separately so it isn't silently missed.
  const unassigned = shapedBookings.filter((b) => !b.driverID && b.status === "upcoming");
  const missingWhileOngoing = shapedBookings.filter((b) => !b.driverID && b.status === "ongoing");

  const driverIDs = driverSnap.docs.map((d) => d.id);
  const [licenseMap, driverNames] = await Promise.all([
    resolveLicenseExpiries(driverIDs),
    resolveDisplayNames(driverIDs),
  ]);

  const drivers = driverSnap.docs.map((d) => {
    const data = d.data();
    const licenseExpiry = licenseMap.get(d.id) || null;
    const lic = licenseStatusOf(licenseExpiry);
    const assignments = shapedBookings
      .filter((b) => b.driverID === d.id)
      .sort((a, b) => (a.startDateTime?.getTime() ?? 0) - (b.startDateTime?.getTime() ?? 0));
    return {
      driverID:  d.id,
      name:      driverNames.get(d.id) || [data.firstName, data.lastName].filter(Boolean).join(" ").trim() || data.username || data.email || "—",
      phone:     data.phone || "—",
      profileImage: data.profileImage || null, // avatar URL (Firebase Storage); the UI falls back to an icon
      status:    data.status || "Active", // matches Users.jsx directory convention
      license: {
        status:   lic.status, // "expired" | "expiring" | "ok" | "none"
        daysLeft: lic.daysLeft,
        expiry:   licenseExpiry ? licenseExpiry.toISOString() : null,
      },
      assignments,
    };
  });

  return { drivers, unassigned, missingWhileOngoing };
};

// ─────────────────────────────────────────────
// Overlap check: does `driverID` already have a live (upcoming/ongoing)
// booking whose window overlaps [startDateTime, endDateTime]?
// Excludes the booking being assigned itself (for reassignment).
// ─────────────────────────────────────────────
// A driver's bookings (as { id, ...data }) in the given statuses, from driverAssignments.
// The current assignment always wins, so a booking reassigned to someone else drops out.
//   * live statuses (upcoming/ongoing) only need the driver's "assigned" rows;
//   * history statuses also need the "completed" ones.
// Only driverAssignments is read: no booking.driverID query (and so no composite index for it).
const getDriverBookings = async (driverID, statuses) => {
  const liveOnly = statuses.every((s) => DISPATCHABLE_STATUSES.includes(s));
  const assignments = await getAssignmentsForDriver(
    driverID,
    liveOnly ? [ASSIGNMENT_STATUS.ASSIGNED] : [ASSIGNMENT_STATUS.ASSIGNED, ASSIGNMENT_STATUS.COMPLETED],
  );

  const byId = new Map();
  (await getBookingsByKeys(assignments.map((a) => a.bookingID))).forEach((b) => {
    if (statuses.includes(b.status)) byId.set(b.id, b);
  });

  const rows = [...byId.values()];
  await attachCurrentDrivers(rows);

  // attachCurrentDrivers only knows "assigned" rows. Once a trip is over, its row flips to "completed", so the
  // booking would come back with no driver and be filtered out below -- which emptied the driver's History tab.
  // A finished trip still belongs to the driver whose own (completed) row it is, so keep that link.
  const rowByKey = new Map(assignments.map((a) => [a.bookingID, a]));
  // enRouteAt lives on the assignment row, not the booking.
  rows.forEach((b) => { b.enRouteAt = rowByKey.get(bookingKeyOf(b.id, b))?.enRouteAt || null; });
  rows.forEach((b) => {
    if (b.driverID) return;
    const a = rowByKey.get(bookingKeyOf(b.id, b));
    if (a && a.status === ASSIGNMENT_STATUS.COMPLETED && a.driverID === driverID) {
      b.driverID         = a.driverID;
      b.driverAssignedAt = a.assignedAt || null;
      b.driverAssignedBy = a.assignedBy || null;
    }
  });

  return rows.filter((b) => b.driverID === driverID);
};

// One driver's schedule against one booking: free, "tight" (gap shorter than the buffer) or "overlap".
// The rules live in driverConflict.service.js; this only picks the window to test. A late ongoing trip
// is busy until now, so a booking that is itself running late is tested with that later end.
// Pass a Firestore transaction `t` to make the reads part of it.
const findDriverConflicts = async (driverID, booking, bookingDocID, bufferMinutes, t = null) => {
  const start = toJSDate(booking.startDateTime);
  if (!start) return { worst: null, all: [] };
  const end = effectiveEnd(booking) || start;
  const others = await getDriverLiveBookings(driverID, t);
  return evaluateDriverSchedule(others, {
    start, end, bufferMs: bufferMinutes * 60 * 1000, excludeDocID: bookingDocID,
  });
};

const conflictSummary = (c, bufferMinutes) => c && ({
  id: c.id, bookingID: c.bookingID, type: c.type,
  startDateTime: c.startDateTime, endDateTime: c.endDateTime, gapMinutes: c.gapMinutes,
  message: describeConflict(c, bufferMinutes),
});

// ─────────────────────────────────────────────
// ASSIGN a driver to a chauffeur booking.
//
// What the caller can run into (all reported together, so one "Assign Anyway" is an informed decision):
//   * expired license            warning  -> force=true overrides
//   * "tight" gap (shorter than  warning  -> force=true overrides
//     the buffer, incl. trips
//     that only touch)
//   * real overlap               needs force=true AND an overrideReason (min OVERRIDE_REASON_MIN_LENGTH
//                                chars), which is written to the audit log
// Every one of these throws with conflict: true (HTTP 409 in the controller). The check and the write are
// ONE transaction (createAssignment's guard). There is no per-driver lock, so two admins assigning the same
// driver to overlapping trips at the exact same moment could both pass (accepted risk).
// ─────────────────────────────────────────────
export const assignDriver = async (bookingDocID, driverID, assignedBy, force = false, editedBy = null, overrideReason = "") => {
  if (!bookingDocID) throw new Error("bookingDocID is required.");
  if (!driverID) throw new Error("driverID is required.");

  const bookingRef = db.collection("bookings").doc(bookingDocID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (booking.modeOfDriving !== "With Chauffeur") {
    throw new Error("This booking is Self Drive and does not need a driver.");
  }
  if (!DISPATCHABLE_STATUSES.includes(booking.status)) {
    throw new Error(`Cannot assign a driver to a booking with status "${booking.status}".`);
  }

  const driverDoc = await db.collection("user").doc(driverID).get();
  if (!driverDoc.exists) throw new Error("Driver not found.");
  const driverRoleID = await resolveRoleID(ROLES.DRIVER);
  if (driverDoc.data().roleID !== driverRoleID) throw new Error("Selected user is not a Driver.");

  const reason = String(overrideReason || "").trim();
  const licenseExpiry  = (await resolveLicenseExpiries([driverID])).get(driverID) || null;
  const licenseExpired = licenseStatusOf(licenseExpiry).status === "expired";
  const bufferMinutes  = await getDriverBufferMinutes();

  const refuse = (message, { worst, overlap }) => {
    const err = new Error(message);
    err.conflict = true; // the frontend turns this into a warning + "Assign Anyway"
    err.conflictBooking = worst ? { id: worst.id, bookingID: worst.bookingID, startDateTime: worst.startDateTime, endDateTime: worst.endDateTime } : null;
    err.conflictType = worst?.type || null; // "overlap" | "tight" | null
    err.requiresReason = !!overlap;         // true: resend with force + overrideReason
    err.licenseExpired = licenseExpired;
    err.bufferMinutes = bufferMinutes;
    return err;
  };

  // Set by the guard on every run (Firestore may retry the transaction), used afterwards for the audit log.
  let found = { worst: null, all: [] };

  // Runs INSIDE the assignment transaction, so the check and the write are one step.
  const guard = async (t) => {
    found = await findDriverConflicts(driverID, booking, bookingDocID, bufferMinutes, t);

    const { worst, all } = found;
    const overlap = all.find((c) => c.type === "overlap") || null;
    if (!licenseExpired && !all.length) return;

    const parts = [];
    if (licenseExpired) parts.push(`This driver's license expired on ${fmtDay(licenseExpiry)}.`);
    if (worst) {
      parts.push(describeConflict(worst, bufferMinutes));
      if (all.length > 1) parts.push(`(${all.length - 1} more trip${all.length - 1 === 1 ? "" : "s"} also clash.)`);
    }

    if (!force) throw refuse(parts.join(" "), { worst, overlap });
    if (overlap && reason.length < OVERRIDE_REASON_MIN_LENGTH) {
      parts.push(`Assigning over a real overlap needs a reason (at least ${OVERRIDE_REASON_MIN_LENGTH} characters).`);
      throw refuse(parts.join(" "), { worst, overlap });
    }
  };

  // The booking's ONE assignment row is updated in place (a different driver replaces the previous one).
  // The three old fields on the booking are dropped in the SAME transaction, so the
  // table is the only source of truth and the two writes cannot half-succeed.
  await createAssignment({
    bookingKey: bookingKeyOf(bookingDocID, booking), driverID, assignedBy,
    bookingRef, bookingPatch: legacyDriverFieldsPatch(),
    guard,
  });

  // Personal notification to the driver themselves.
  createNotification({
    type: "driver_assigned",
    refID: bookingDocID,
    refCollection: "bookings",
    title: "New trip assigned",
    message: `You've been assigned to booking ${booking.bookingID || bookingDocID}.`,
    userID: driverID,
  }).catch((err) => console.error("[NOTIF] driver_assigned create failed:", err.message));

  const driverInfo = await resolveUserInfo(driverID);
  const driverName = driverInfo.name !== "—" ? driverInfo.name : driverID;
  const overlapped = found.all.some((c) => c.type === "overlap");
  const tightOnly  = !overlapped && found.all.length > 0;
  const overrides = [
    licenseExpired && "expired license",
    overlapped && `overlapping trip - reason: ${reason}`,
    tightOnly && "tight gap between trips",
  ].filter(Boolean);
  createAuditLog({
    action: "update",
    bookingID: booking.bookingID || bookingDocID, // links the entry (and an override reason) to the booking
    description: `Driver ${driverName} assigned to booking ${booking.bookingID || bookingDocID}` +
      `${force && overrides.length ? ` (override — ${overrides.join(", ")})` : ""}.`,
    userID: editedBy,
  }).catch((err) => console.error("[AUDIT] driver assign log failed:", err.message));

  return { id: bookingDocID, driverID };
};

// ─────────────────────────────────────────────
// AVAILABILITY for one booking: every Driver as "free" | "tight" | "busy" for THAT booking's window, so the
// picker can show it before an admin clicks. "busy" = a real overlap, "tight" = a gap shorter than the buffer.
// Read-only; assignDriver still re-checks inside its transaction.
// ─────────────────────────────────────────────
export const getDriverAvailabilityForBooking = async (bookingDocID) => {
  if (!bookingDocID) throw new Error("bookingID is required.");

  const bookingDoc = await db.collection("bookings").doc(bookingDocID).get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  const driverRoleID = await resolveRoleID(ROLES.DRIVER);
  if (!driverRoleID) throw new Error("Could not resolve the Driver role ID.");

  const [driverSnap, bufferMinutes] = await Promise.all([
    db.collection("user").where("roleID", "==", driverRoleID).get(),
    getDriverBufferMinutes(),
  ]);
  const licenseMap = await resolveLicenseExpiries(driverSnap.docs.map((d) => d.id));

  const drivers = await Promise.all(driverSnap.docs.map(async (d) => {
    const { worst, all } = await findDriverConflicts(d.id, booking, bookingDocID, bufferMinutes);
    const status = all.some((c) => c.type === "overlap") ? "busy" : all.length ? "tight" : "free";
    return {
      driverID: d.id,
      status,
      conflict: conflictSummary(worst, bufferMinutes),
      conflictCount: all.length,
      licenseExpired: licenseStatusOf(licenseMap.get(d.id) || null).status === "expired",
    };
  }));

  return { bookingID: booking.bookingID || bookingDocID, bufferMinutes, drivers };
};

// ─────────────────────────────────────────────
// UNASSIGN — clears the driver, returning the booking to the queue
// (if it's still "upcoming") or just freeing the driver (if "ongoing").
// ─────────────────────────────────────────────
export const unassignDriver = async (bookingDocID, editedBy = null) => {
  if (!bookingDocID) throw new Error("bookingDocID is required.");

  const bookingRef = db.collection("bookings").doc(bookingDocID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (!DISPATCHABLE_STATUSES.includes(booking.status)) {
    throw new Error(`Cannot unassign a driver from a booking with status "${booking.status}".`);
  }

  // Closing the row and dropping the legacy booking fields commit together.
  const ended = await endActiveAssignment(bookingKeyOf(bookingDocID, booking), {
    status: ASSIGNMENT_STATUS.UNASSIGNED,
    bookingRef,
    bookingPatch: legacyDriverFieldsPatch(),
  });
  const previousDriverID = ended?.driverID || null;

  // Same gap assignDriver's own notification fixed, just missed on this
  // side: without this, a driver only finds out they were unassigned
  // because the trip silently disappears from their list.
  if (previousDriverID) {
    createNotification({
      type: "driver_unassigned",
      refID: bookingDocID,
      refCollection: "bookings",
      title: "Trip unassigned",
      message: `You've been removed from booking ${booking.bookingID || bookingDocID}.`,
      userID: previousDriverID,
    }).catch((err) => console.error("[NOTIF] driver_unassigned create failed:", err.message));
  }

  let driverName = previousDriverID || "a driver";
  if (previousDriverID) {
    const info = await resolveUserInfo(previousDriverID); // userDetails first, falls back to username/email
    if (info.name !== "—") driverName = info.name;
  }
  createAuditLog({
    action: "update",
    bookingID: booking.bookingID || bookingDocID,
    description: `Driver ${driverName} unassigned from booking ${booking.bookingID || bookingDocID}.`,
    userID: editedBy,
  }).catch((err) => console.error("[AUDIT] driver unassign log failed:", err.message));

  return { id: bookingDocID };
};

// ─────────────────────────────────────────────
// DRIVER SELF-SERVICE — scoped to the logged-in driver's own uid.
// Deliberately separate from getDispatchBoard/assignDriver/unassignDriver
// above (which are Owner/Admin/Supervisor tools over every driver and
// every car) — a Driver hitting these should only ever see or touch their
// own assignments, enforced here via assertOwnsBooking, not just hidden
// in the UI.
// ─────────────────────────────────────────────

const assertOwnsBooking = async (bookingDocID, driverID) => {
  const doc = await db.collection("bookings").doc(bookingDocID).get();
  if (!doc.exists) throw new Error("Booking not found.");
  const currentDriverID = await resolveCurrentDriverID(doc.data(), doc.id);
  if (currentDriverID !== driverID) {
    const err = new Error("This booking is not assigned to you.");
    err.status = 403;
    throw err;
  }
  return doc.data();
};

// Read-only variant: also lets a driver open a trip he already FINISHED (his assignment row is "completed", so he is no
// longer the booking's current driver). Used only by the read-only views (inspection, terms) the History tab needs;
// every action (pickup, dropoff, remind...) still uses assertOwnsBooking above.
const assertOwnsOrFinishedBooking = async (bookingDocID, driverID) => {
  const doc = await db.collection("bookings").doc(bookingDocID).get();
  if (!doc.exists) throw new Error("Booking not found.");
  const currentDriverID = await resolveCurrentDriverID(doc.data(), doc.id);
  if (currentDriverID !== driverID) {
    const finished = await getCompletedAssignment(bookingKeyOf(doc.id, doc.data()), driverID);
    if (!finished) {
      const err = new Error("This booking is not assigned to you.");
      err.status = 403;
      throw err;
    }
  }
  return doc.data();
};

// ─────────────────────────────────────────────
// Read-only inspection proof for the driver's own booking.
//
// Drivers still can't read or write /api/vehicle-docs (staff only) — this is
// a separate, ownership-checked, read-only view of the same records. Only
// what a driver needs to see is returned: exterior photo URLs, videos and
// additional photos (with their captions). NOT the parts condition (which parts
// are Good / damaged) and NOT the per-part photos (a close-up can show a serial
// number) -- those are for staff. No audit/edit info, no staff fields, no
// document ids.
// ─────────────────────────────────────────────
const EXTERIOR_FIELDS = [
  ["frontViewUrl", "Front view"],
  ["sideViewUrl",  "Side view"],
  ["backViewUrl",  "Back view"],
];
const humanizeFieldKey = (k) =>
  k.replace(/Url$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const isHttpUrl = (v) => typeof v === "string" && /^https?:\/\//i.test(v);

const shapeInspectionForDriver = (doc) => {
  const exterior = EXTERIOR_FIELDS
    .filter(([k]) => isHttpUrl(doc?.[k]))
    .map(([k, label]) => ({ key: k, label, url: doc[k] }));
  const videos = (Array.isArray(doc?.videos) ? doc.videos : [])
    .filter((v) => isHttpUrl(v?.url))
    .map((v) => ({ url: v.url }));
  const extraPhotos = (Array.isArray(doc?.extraPhotos) ? doc.extraPhotos : [])
    .filter((p) => isHttpUrl(p?.url))
    .map((p) => ({ url: p.url, ...(p.caption ? { caption: p.caption } : {}) }));
  return { exterior, videos, extraPhotos };
};

/** Before + after inspection proof for one of THIS driver's bookings (read-only). */
export const getMyTripInspection = async (bookingDocID, driverID) => {
  const booking = await assertOwnsOrFinishedBooking(bookingDocID, driverID);
  // Records may have been saved under the business bookingID or the doc id.
  const keys = [...new Set([booking.bookingID, bookingDocID].filter(Boolean))];
  const docResults = await Promise.all(keys.map((k) => getVehicleDocsByBooking(k)));
  const firstOf = (list, phase) => list.map((r) => r?.[phase]).find(Boolean) || null;
  return {
    before: shapeInspectionForDriver(firstOf(docResults, "before")),
    after:  shapeInspectionForDriver(firstOf(docResults, "after")),
  };
};

/**
 * The Terms & Conditions the customer agreed to for THIS booking (read-only, ownership-checked).
 * Returns the exact version the booking points to, not the current Terms, so a later edit of the
 * Terms never changes what the driver sees.
 * available:false when the booking has no recorded agreement.
 */
export const getMyTripTerms = async (bookingDocID, driverID) => {
  const booking = await assertOwnsOrFinishedBooking(bookingDocID, driverID);
  const id = booking.termsVersionID || null;
  if (!id) return { available: false };
  const terms = await getTermsVersion(id);
  if (!terms) return { available: false };
  const at = booking.termsAcceptedAt;
  return {
    available: true,
    version: terms.version ?? null,
    acceptedAt: at?.toDate ? at.toDate().toISOString() : (at ?? null),
    content: terms.content || "",
  };
};

// ─────────────────────────────────────────────
// "On my way" — the chauffeur is driving to the customer's pickup location.
//
// NOT Start Pickup: Start Pickup means the customer has already been received
// (booking -> ongoing, trip tracking starts). This is the step before it. It
// stamps enRouteAt on the driver's assignment row, which (1) tells the customer's app the driver is
// coming (notification -> the temporary arrival page) and (2) opens the short
// window in which the customer may see the car's position and plate number.
// The window closes by itself at Start Pickup (the customer app only serves it
// while the booking is still "upcoming"). Same readiness gate as pickup, since
// the car leaves the lot here.
// ─────────────────────────────────────────────
const firstNameOf = async (userID) => {
  try {
    const d = await db.collection("userDetails").doc(userID).get();
    return (d.exists && (d.data().firstName || "").trim()) || "";
  } catch { return ""; }
};

export const driverOnMyWay = async (bookingDocID, driverID) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;

  if ((booking.status || "").toLowerCase() !== "upcoming") {
    throw driverErr(400, "You can only head out for a trip that is still upcoming.");
  }
  if (booking.modeOfDriving !== "With Chauffeur") {
    throw driverErr(400, "This booking is not a chauffeur booking.");
  }
  const current = await getActiveAssignment(bookingKeyOf(bookingDocID, booking));
  if (current?.enRouteAt) return { id: bookingDocID, alreadyOnTheWay: true };

  // Same readiness gate as Start Pickup (payment settled + before-trip inspection complete).
  const docKeys = [...new Set([booking.bookingID, bookingDocID].filter(Boolean))];
  const [pay, checklist] = await Promise.all([resolvePaymentInfo(bID), getPhaseChecklist(docKeys, "before")]);
  const paymentReady = ["approved", "paid"].includes((pay.paymentStatus || "").toLowerCase()) && (pay.balance ?? 0) <= 0;
  if (!paymentReady) throw driverErr(400, "Payment still needs to be settled before you head out.");
  if (!checklist.complete) throw driverErr(400, "The vehicle inspection must be complete before you head out.");

  const firstName = await firstNameOf(driverID);
  const stamped = await markEnRoute(bookingKeyOf(bookingDocID, booking), driverID); // two quick taps land as one
  if (!stamped) throw driverErr(403, "This booking is not assigned to you.");
  if (stamped.alreadyOnTheWay) return { id: bookingDocID, alreadyOnTheWay: true };

  if (booking.userID) {
    try {
      await createNotification({
        type: "driver_en_route",
        refID: bID,
        refCollection: "bookings",
        userID: booking.userID,
        title: "Your driver is on the way",
        message: `${firstName || "Your driver"} is heading to your pickup location now. Tap to see the car, its plate number and where it is.`,
      });
    } catch (err) {
      console.error("[DRIVER DISPATCH] driver_en_route notify failed:", err.message);
    }
  }
  return { id: bookingDocID };
};

// ─────────────────────────────────────────────
// "Remind customer" — a driver blocked at Pickup by an unpaid balance can't
// fix it (staff collect it), but the customer can: this rings their bell.
// 10-minute cooldown enforced here on the server (balanceReminders/{bookingKey}).
// ─────────────────────────────────────────────
const pesoText = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const startText = (d) => {
  const dt = toJSDate(d);
  return dt ? dt.toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }) : "";
};

export const driverRemindBalance = async (bookingDocID, driverID) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;

  if ((booking.status || "").toLowerCase() !== "upcoming") {
    throw driverErr(400, "A balance reminder can only be sent while the trip is still upcoming.");
  }
  if (!booking.userID) throw driverErr(400, "This booking has no customer account to notify.");

  const pay = await resolvePaymentInfo(bID);
  const balance = Number(pay.balance) || 0;
  if (balance <= 0) throw driverErr(400, "There is no balance remaining on this booking.");

  // Reserve the cooldown slot first (transactionally), THEN notify; hand the slot back if notifying fails.
  const ref   = db.collection(BALANCE_REMINDERS).doc(bID);
  const nowTs = admin.firestore.Timestamp.now();
  let previous = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    previous = snap.exists ? snap.data() : null;
    const left = previous ? balanceSecondsLeft(tsToMs(previous.lastRemindedAt), nowTs.toMillis()) : 0;
    if (left > 0) throw driverErr(429, "The customer was already reminded recently.", { retryAfterSeconds: left });
    tx.set(ref, { bookingKey: bID, bookingDocID, driverID, lastRemindedAt: nowTs, count: (previous?.count || 0) + 1 });
  });

  try {
    const when = startText(booking.startDateTime);
    await createNotification({
      type: "balance_reminder",
      refID: bID,
      refCollection: "bookings",
      userID: booking.userID,
      title: "Balance remaining on your booking",
      message: `You still have a balance of ${pesoText(balance)} on your booking${when ? ` starting ${when}` : ""}. Please pay it online from your booking page before pickup.`,
      renotify: true, // a second reminder rings the bell again instead of being swallowed
    });
  } catch (err) {
    // Give the slot back so a failed send doesn't lock the driver out for 10 minutes.
    try {
      if (previous) await ref.set(previous); else await ref.delete();
    } catch { /* best effort */ }
    throw err;
  }
  return { id: bookingDocID, balance };
};

/** A driver's own live trips (upcoming + ongoing), same shape as getDispatchBoard's per-booking entries. */
export const getMyTrips = async (driverID) => {
  if (!driverID) throw new Error("driverID is required.");

  const bookings = await getDriverBookings(driverID, DISPATCHABLE_STATUSES);

  // withDocs: MyTrips needs to know whether staff have finished the
  // before/after vehicle inspection (photos + parts condition) so Start
  // Pickup / Return can show what's still outstanding. History rows don't
  // need it (skipped there).
  return shapeTripsForDriver(bookings, { withDocs: true, driverID });
};

/** A driver's past trips — completed/cancelled/stolen — most recent first. Simple, no pagination (per-driver volume is small). */
export const getMyTripHistory = async (driverID) => {
  if (!driverID) throw new Error("driverID is required.");

  const bookings = await getDriverBookings(driverID, ["completed", "cancelled", "stolen"]);

  const shaped = await shapeTripsForDriver(bookings, { driverID });
  return shaped.sort((a, b) => (b.startDateTime?.getTime() ?? 0) - (a.startDateTime?.getTime() ?? 0));
};

// Shared shaping for the two driver-facing lists above — same vehicle/
// customer resolution as getDispatchBoard, plus each booking's session
// (for startedAt/droppedOffTime display) plus the booking's own completedAt.
// "Remind customer" (balance) cooldown — same 10 minutes and same server-side
// rule as Remind Staff, kept per booking in balanceReminders/{bookingKey}.
const BALANCE_REMINDER_COOLDOWN_SECONDS = 10 * 60;
const BALANCE_REMINDERS = "balanceReminders";

const driverErr = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const tsToMs = (ts) => {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
};
const balanceSecondsLeft = (lastMs, nowMs = Date.now()) =>
  lastMs == null ? 0 : Math.max(0, Math.ceil((BALANCE_REMINDER_COOLDOWN_SECONDS * 1000 - (nowMs - lastMs)) / 1000));

/** { [bookingKey]: secondsLeft } — never throws; a failure just shows the button as available (server still enforces). */
const getBalanceReminderCooldowns = async (bookingKeys = []) => {
  const keys = [...new Set(bookingKeys.filter(Boolean))];
  const out = {};
  if (!keys.length) return out;
  try {
    const snaps = await db.getAll(...keys.map((k) => db.collection(BALANCE_REMINDERS).doc(k)));
    const now = Date.now();
    keys.forEach((k, i) => { out[k] = snaps[i].exists ? balanceSecondsLeft(tsToMs(snaps[i].data().lastRemindedAt), now) : 0; });
  } catch (err) {
    console.error("[BALANCE REMINDER] cooldown lookup failed:", err.message);
  }
  return out;
};

const shapeTripsForDriver = async (bookings, { withDocs = false, driverID = null } = {}) => {
  const carIDs      = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];
  const userIDs     = [...new Set(bookings.map((b) => b.userID).filter(Boolean))];
  const bookingIDs  = [...new Set(bookings.map((b) => b.bookingID || b.id).filter(Boolean))];
  // Inspection records may have been saved under the booking's business
  // bookingID or its doc id — check both.
  const docKeys = {};
  bookings.forEach((b) => { docKeys[b.bookingID || b.id] = [...new Set([b.bookingID, b.id].filter(Boolean))]; });

  const [vehicleEntries, userEntries, sessions, paymentEntries, beforeDocsEntries, afterDocsEntries, reminderCooldowns, balanceCooldowns, penaltiesByBooking] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
    Promise.all(bookings.map((b) => getSessionByBookingID(b.bookingID || b.id).catch(() => null))),
    Promise.all(bookingIDs.map((id) => resolvePaymentInfo(id).then((p) => [id, p]))),
    // Same helper + same key (bookingID || doc id) as booking.service.js's
    // getAllBookings, so Car Tracking and My Trips agree on "inspection done".
    Promise.all(bookingIDs.map((id) => (withDocs ? getPhaseChecklist(docKeys[id] || id, "before") : Promise.resolve(EMPTY_CHECKLIST)).then((v) => [id, v]))),
    Promise.all(bookingIDs.map((id) => (withDocs ? getPhaseChecklist(docKeys[id] || id, "after")  : Promise.resolve(EMPTY_CHECKLIST)).then((v) => [id, v]))),
    // Remaining "Remind Staff" cooldown per booking/phase (seconds, so the
    // driver's own clock can't skew the countdown).
    withDocs ? getReminderCooldowns(bookingIDs) : Promise.resolve({}),
    withDocs ? getBalanceReminderCooldowns(bookingIDs) : Promise.resolve({}),
    // The driver's view of the penalties on each trip (what was noted + where it stands with staff; no money owed).
    listPenaltiesForDriver(bookingIDs, driverID),
  ]);
  const vehicleMap = Object.fromEntries(vehicleEntries);
  const userMap    = Object.fromEntries(userEntries);
  const paymentMap = Object.fromEntries(paymentEntries);
  const beforeDocsMap = Object.fromEntries(beforeDocsEntries);
  const afterDocsMap  = Object.fromEntries(afterDocsEntries);

  return bookings
    .map((b, i) => {
      const bID = b.bookingID || b.id;
      // A cancelled booking always shows "Cancelled" payment status,
      // matching booking.service.js/payments.service.js's same override.
      const payInfo = paymentMap[bID] || EMPTY_PAYMENT;
      const paymentStatus = (b.status || "").toLowerCase() === "cancelled" ? "Cancelled" : payInfo.paymentStatus;
      return {
        id:                   b.id,
        bookingID:            bID,
        status:               b.status,
        modeOfDriving:        b.modeOfDriving,
        startDateTime:        toJSDate(b.startDateTime),
        endDateTime:          toJSDate(b.endDateTime),
        location:             b.location || "—",
        vehicleName:          vehicleMap[b.carID] || "—",
        carID:                b.carID || null,
        customerName:         userMap[b.userID]?.name || "—",
        customerPhone:        userMap[b.userID]?.phone || "—",
        startedAt:            toJSDate(sessionStartedAt(sessions[i]?.data)),
        droppedOffTime:       toJSDate(sessions[i]?.data?.droppedOffTime),
        // ACTUAL return — stamped on the booking when Return is confirmed.
        completedAt:           toJSDate(b.completedAt),
        // Set by the customer backend at booking time (see bookingsession.model.js).
        // Null when a session hasn't been created yet / doesn't have coords geocoded.
        pickupLocation:       sessions[i]?.data?.pickupLocation || null,
        dropoffLocation:      sessions[i]?.data?.dropoffLocation || null,
        // Extra stops the customer selected at booking time, beyond
        // pickup/dropoff (same field CarTracking's live map and
        // BookingInfoPanel already read off the session doc). Without
        // this, MyTrips.jsx's tripStops() always saw an empty/undefined
        // list here and could only ever plot the two endpoints — this is
        // what was missing.
        geofenceZones:        sessions[i]?.data?.geofenceZones || [],
        // Number Coding restrictions the customer was warned about when booking (flat array saved
        // on the session by the customer backend) — shown on the driver's trip card so the route
        // can be planned around them. [] for older sessions.
        codingWarnings:       Array.isArray(sessions[i]?.data?.codingWarnings) ? sessions[i].data.codingWarnings : [],
        // Nested to match PaymentStatusModal's `payment` prop shape exactly
        // (see MyTrips.jsx: <PaymentStatusModal payment={paymentTrip?.payment} />).
        payment: { ...payInfo, paymentStatus },
        // Inspection state — consumed by MyTrips.jsx. "Complete" = the 3
        // exterior photos AND the parts-condition record, both entered by
        // staff; the per-half breakdown drives the checklist on the card.
        beforeDocsComplete:   beforeDocsMap[bID]?.complete ?? false,
        afterDocsComplete:    afterDocsMap[bID]?.complete ?? false,
        beforeInspection:     beforeDocsMap[bID] ?? EMPTY_CHECKLIST,
        afterInspection:      afterDocsMap[bID]  ?? EMPTY_CHECKLIST,
        inspectionReminder:   reminderCooldowns[bID] ?? { before: { retryAfterSeconds: 0 }, after: { retryAfterSeconds: 0 } },
        // Set when the driver tapped "On my way" (heading to the customer's pickup location).
        enRouteAt:            toJSDate(b.enRouteAt),
        // Seconds left before the driver can send another balance reminder to the customer.
        balanceReminder:      { retryAfterSeconds: balanceCooldowns[bID] ?? 0 },
        // Penalties on this trip, trimmed for the driver: Under review / Accepted / Rejected / Removed, no payment details.
        penalties:            penaltiesByBooking[bID] || [],
      };
    })
    .sort((a, b) => (a.startDateTime?.getTime() ?? 0) - (b.startDateTime?.getTime() ?? 0));
};

/** Driver-triggered pickup — ownership-checked, then reuses the same gated updateBooking staff already use (payment + completed before-trip inspection checks included — the driver can't fill the inspection in themselves, so it must already be done by staff). */
export const driverPickup = async (bookingDocID, driverID) => {
  await assertOwnsBooking(bookingDocID, driverID);
  await updateBooking(bookingDocID, { status: "ongoing" });
  return { id: bookingDocID };
};

/**
 * Driver tapping "Remind Staff" on a trip whose before/after inspection
 * isn't done yet — notifies Owner/Admin/Supervisor. Ownership-checked like
 * every other driver action; the 10-minute cooldown is enforced inside
 * sendInspectionReminder.
 */
export const driverRemindInspection = async (bookingDocID, driverID, phase) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;

  // Pickup needs payment settled too. If payment is what's really blocking
  // the trip, an inspection reminder would only send staff chasing the
  // wrong thing — so say so instead.
  if (phase === "before") {
    const pay = await resolvePaymentInfo(bID);
    const paymentReady = ["approved", "paid"].includes((pay.paymentStatus || "").toLowerCase()) && (pay.balance ?? 0) <= 0;
    if (!paymentReady) {
      const err = new Error("Payment still needs to be settled before pickup — sort that out first.");
      err.status = 400;
      throw err;
    }
  }

  const [vehicleName, driverInfo] = await Promise.all([
    resolveVehicleName(booking.carID),
    resolveUserInfo(driverID),
  ]);

  return sendInspectionReminder({
    booking, bookingDocID, phase, driverID,
    driverName: driverInfo.name,
    vehicleName,
  });
};

/** Driver-triggered drop-off — ownership-checked, then the same rules as the staff dropoff endpoint. */
export const driverDropoff = async (bookingDocID, driverID) => {
  await assertOwnsBooking(bookingDocID, driverID);
  await markBookingDroppedOff(bookingDocID, driverID);
  return { id: bookingDocID };
};

/**
 * Driver noting a penalty on their own trip. Same createPenalty staff use,
 * but saved UnderReview: the customer is NOT notified and it isn't charged
 * until a supervisor confirms it on the Penalties page (staff are notified
 * that it needs review). Also does the ownership check, so a driver can't
 * note one on a booking that isn't theirs through the general
 * POST /api/penalties route's reach.
 * bookingID here is the booking DOC id from the URL, resolved to the
 * business bookingID the penalty service keys on.
 */
const penaltySignature = (items) =>
  (Array.isArray(items) ? items : [])
    .map((i) => `${String(i?.description || "").trim().toLowerCase()}|${(Math.round((Number(i?.amount) || 0) * 100) / 100).toFixed(2)}`)
    .sort()
    .join(";");

export const driverCreatePenalty = async (bookingDocID, driverID, body = {}) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;

  // A driver notes a penalty during the trip (the button only shows on an ongoing trip; this is the same rule on the server).
  if ((booking.status || "").toLowerCase() !== "ongoing") {
    return { error: "You can only note a penalty while the trip is ongoing." };
  }
  // The same charge, noted again by this driver while the first is still waiting for review, is almost always a double tap.
  const existing = await db.collection("penalties").where("bookingID", "==", bID).get();
  const wanted = penaltySignature(body.lineItems);
  const duplicate = existing.docs.some((d) => {
    const p = d.data();
    return p.status === "UnderReview" && p.createdBy === driverID && penaltySignature(p.lineItems) === wanted;
  });
  if (duplicate) return { error: "You already noted this penalty — it's waiting for a supervisor's review." };

  return createPenalty({
    bookingID: bID,
    lineItems: body.lineItems,
    computedAmount: body.computedAmount ?? 0,
    amount: body.amount,
    overrideReason: body.overrideReason || "",
    createdBy: driverID,
    needsReview: true,
  });
};

/**
 * Driver correcting a penalty they noted, while it is still Under review (see editPenaltyAsDriver). It is the penalty's
 * creator who is checked, not the trip: the trip may well be over by the time a supervisor gets to it.
 */
export const driverEditPenalty = async (penaltyID, driverID, body = {}) => {
  return editPenaltyAsDriver(penaltyID, driverID, {
    lineItems: body.lineItems,
    amount: body.amount,
    overrideReason: body.overrideReason || "",
  });
};

// ─────────────────────────────────────────────
// ACTIVITY for ONE driver — Users > Driver > Activity tab. Staff-facing and read-only.
//   current: the driver's upcoming / ongoing trips
//   history: completed trips that have this driver on them, newest first
// Built straight from the driver's driverAssignments rows. getDriverBookings() is not used here: it
// keeps only bookings whose CURRENT assignment is "assigned", so it would drop every finished trip
// (its row flips to "completed"). A booking that was archived since is looked up in bookingArchives,
// so a finished trip does not vanish from the history when staff archive it.
// ─────────────────────────────────────────────
const lookupArchivedBookings = async (keys) => {
  const byKey = new Map();
  const add = (doc) => {
    const data = doc.data();
    const key = data.bookingID || doc.id;
    if (!byKey.has(key)) byKey.set(key, { ...data, id: doc.id, archived: true });
  };
  for (let i = 0; i < keys.length; i += 30) {
    const part = keys.slice(i, i + 30);
    const snap = await db.collection("bookingArchives").where("bookingID", "in", part).get();
    snap.forEach(add);
  }
  // A booking archive's document ID is the booking's own doc ID: fetch what is still missing directly by ID.
  const stillMissing = keys.filter((k) => k && !byKey.has(k));
  const direct = await Promise.all(stillMissing.map((k) => db.collection("bookingArchives").doc(String(k)).get()));
  direct.filter((s) => s.exists).forEach(add);
  return byKey;
};

export const getDriverActivity = async (driverID) => {
  if (!driverID) throw new Error("driverID is required.");

  const driverDoc = await db.collection("user").doc(driverID).get();
  if (!driverDoc.exists) throw new Error("Driver not found.");
  const driverRoleID = await resolveRoleID(ROLES.DRIVER);
  if (driverDoc.data().roleID !== driverRoleID) throw new Error("This user is not a Driver.");

  const assignments = await getAssignmentsForDriver(driverID, [ASSIGNMENT_STATUS.ASSIGNED, ASSIGNMENT_STATUS.COMPLETED]);
  const rowByKey = new Map(assignments.map((a) => [a.bookingID, a]));
  const keys = [...rowByKey.keys()].filter(Boolean);
  if (!keys.length) return { current: [], history: [] };

  const trips = new Map(); // booking key -> { ...booking, archived }
  (await getBookingsByKeys(keys)).forEach((b) => trips.set(bookingKeyOf(b.id, b), { ...b, archived: false }));
  const missing = keys.filter((k) => !trips.has(k));
  if (missing.length) (await lookupArchivedBookings(missing)).forEach((b, k) => trips.set(k, b));

  const current = [];
  const history = [];
  trips.forEach((b, key) => {
    const status = String(b.status || "").toLowerCase();
    const row = rowByKey.get(key);
    if (!b.archived && DISPATCHABLE_STATUSES.includes(status) && row?.status === ASSIGNMENT_STATUS.ASSIGNED) current.push(b);
    else if (status === "completed") history.push(b);
  });

  const all = [...current, ...history];
  const carIDs  = [...new Set(all.map((b) => b.carID).filter(Boolean))];
  const userIDs = [...new Set(all.map((b) => b.userID).filter(Boolean))];
  const [vehicleEntries, userEntries] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
  ]);
  const vehicleMap = Object.fromEntries(vehicleEntries);
  const userMap    = Object.fromEntries(userEntries);

  const shape = (b) => ({
    id:            b.id,
    bookingID:     b.bookingID || b.id,
    status:        b.status,
    startDateTime: toJSDate(b.startDateTime),
    endDateTime:   toJSDate(b.endDateTime),
    completedAt:   toJSDate(b.completedAt),
    location:      b.location || "—",
    vehicleName:   vehicleMap[b.carID] || "—",
    customerName:  (b.archived && b.customerName) || userMap[b.userID]?.name || "—",
    archived:      !!b.archived, // archived trips have no live booking to open
  });
  const time = (d) => d?.getTime() ?? 0;

  return {
    current: current.map(shape).sort((a, b) => time(a.startDateTime) - time(b.startDateTime)),
    history: history.map(shape).sort((a, b) => time(b.completedAt || b.endDateTime || b.startDateTime) - time(a.completedAt || a.endDateTime || a.startDateTime)),
  };
};