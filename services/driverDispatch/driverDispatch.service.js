import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { ROLES, resolveRoleID } from "../../utils/roles/role.util.js";
import { updateBooking, markBookingDroppedOff } from "../../services/booking/booking.service.js";
import { getSessionByBookingID } from "../../services/booking/bookingSession.service.js";
import { hasCompleteBeforeTripDocs, hasCompleteAfterTripDocs } from "../../services/vehicleDocumentation/vehicleDocumentation.service.js";
import { computeAmounts, collectRemainingBalance, confirmInitialPayment, markRefundIssued } from "../../services/payments/payments.service.js";
import { createNotification } from "../../services/notification/notification.service.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";

// ─────────────────────────────────────────────
// Helpers (deliberately self-contained rather than importing from
// booking.service.js — those helpers aren't exported, and duplicating
// small resolvers like this per-module is the existing convention here,
// see booking.service.js vs payments.service.js both having their own
// resolveVehicleName/resolveUserInfo).
// ─────────────────────────────────────────────

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const fmtDate = (d) =>
  d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

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
const EMPTY_PAYMENT = { totalFee: 0, amountPaid: 0, balance: 0, payType: "—", paymentStatus: "—", discountAmount: 0, refundDue: 0, refundIssued: false };
const resolvePaymentInfo = async (bookingID) => {
  if (!bookingID) return EMPTY_PAYMENT;
  try {
    const snap = await db.collection("payments")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    if (snap.empty) return EMPTY_PAYMENT;
    const data = snap.docs[0].data();
    const { amountPaid, balance, payType, refundDue } = computeAmounts(data);
    let paymentStatus = data.status || "Pending";
    if (paymentStatus.toLowerCase() === "paid") paymentStatus = "Approved";
    return {
      totalFee: Number(data.amount) || 0, amountPaid, balance, payType, paymentStatus,
      discountAmount: Number(data.discountAmount) || 0,
      refundDue, refundIssued: !!data.refundIssued,
    };
  } catch { return EMPTY_PAYMENT; }
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

  const licenseMap = await resolveLicenseExpiries(driverSnap.docs.map((d) => d.id));

  const drivers = driverSnap.docs.map((d) => {
    const data = d.data();
    const licenseExpiry = licenseMap.get(d.id) || null;
    const lic = licenseStatusOf(licenseExpiry);
    const assignments = shapedBookings
      .filter((b) => b.driverID === d.id)
      .sort((a, b) => (a.startDateTime?.getTime() ?? 0) - (b.startDateTime?.getTime() ?? 0));
    return {
      driverID:  d.id,
      name:      [data.firstName, data.lastName].filter(Boolean).join(" ").trim() || data.username || data.email || "—",
      phone:     data.phone || "—",
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
const findDriverConflict = async (driverID, startDateTime, endDateTime, excludeBookingDocID) => {
  const snaps = await Promise.all(
    DISPATCHABLE_STATUSES.map((s) =>
      db.collection("bookings").where("driverID", "==", driverID).where("status", "==", s).get()
    )
  );

  const start = toJSDate(startDateTime);
  const end   = toJSDate(endDateTime);
  if (!start || !end) return null;

  for (const snap of snaps) {
    for (const doc of snap.docs) {
      if (doc.id === excludeBookingDocID) continue;
      const b = doc.data();
      const bStart = toJSDate(b.startDateTime);
      const bEnd   = toJSDate(b.endDateTime);
      if (!bStart || !bEnd) continue;
      if (start < bEnd && end > bStart) {
        return { id: doc.id, bookingID: b.bookingID || doc.id, startDateTime: bStart, endDateTime: bEnd };
      }
    }
  }
  return null;
};

// ─────────────────────────────────────────────
// ASSIGN a driver to a chauffeur booking.
// Throws (with conflict: true) on a schedule overlap unless force=true —
// the frontend is expected to show that as a warning and let the caller
// re-submit with force to override, rather than silently blocking.
// ─────────────────────────────────────────────
export const assignDriver = async (bookingDocID, driverID, assignedBy, force = false, editedBy = null) => {
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

  // Warnings the caller can override with force=true — never a hard block:
  //   • the driver's license is already expired
  //   • the driver already has an overlapping trip
  // Reported together so one "Assign Anyway" click is an informed decision
  // about everything, not just the first thing that was found.
  const licenseExpiry  = (await resolveLicenseExpiries([driverID])).get(driverID) || null;
  const licenseExpired = licenseStatusOf(licenseExpiry).status === "expired";
  const conflict = await findDriverConflict(driverID, booking.startDateTime, booking.endDateTime, bookingDocID);

  if ((licenseExpired || conflict) && !force) {
    const parts = [];
    if (licenseExpired) parts.push(`This driver's license expired on ${fmtDay(licenseExpiry)}.`);
    if (conflict) {
      parts.push(
        `This driver is already assigned to booking ${conflict.bookingID} ` +
        `from ${fmtDate(conflict.startDateTime)} to ${fmtDate(conflict.endDateTime)}, ` +
        `which overlaps this trip.`
      );
    }
    const err = new Error(parts.join(" "));
    err.conflict = true; // the frontend already turns this into a warning + "Assign Anyway"
    err.conflictBooking = conflict || null;
    err.licenseExpired = licenseExpired;
    throw err;
  }

  await bookingRef.update({
    driverID,
    driverAssignedAt: timestamp(),
    driverAssignedBy: assignedBy || "admin",
    updatedAt: timestamp(),
  });

  // Personal notification to the driver themselves — didn't exist before
  // this; assignDriver() used to only update the booking doc with no
  // notification at all, so a driver had no way to find out except
  // checking their trip list manually.
  createNotification({
    type: "driver_assigned",
    refID: bookingDocID,
    refCollection: "bookings",
    title: "New trip assigned",
    message: `You've been assigned to booking ${booking.bookingID || bookingDocID}.`,
    userID: driverID,
  }).catch((err) => console.error("[NOTIF] driver_assigned create failed:", err.message));

  const driverData = driverDoc.data();
  const driverName = [driverData.firstName, driverData.lastName].filter(Boolean).join(" ").trim()
    || driverData.username || driverID;
  createAuditLog({
    action: "update",
    description: `Driver ${driverName} assigned to booking ${booking.bookingID || bookingDocID}` +
      `${force && (licenseExpired || conflict)
        ? ` (override — ${[licenseExpired && "expired license", conflict && "scheduling conflict"].filter(Boolean).join(", ")})`
        : ""}.`,
    userID: editedBy,
  }).catch((err) => console.error("[AUDIT] driver assign log failed:", err.message));

  return { id: bookingDocID, driverID };
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

  const previousDriverID = booking.driverID;

  await bookingRef.update({
    driverID: null,
    driverAssignedAt: null,
    driverAssignedBy: null,
    updatedAt: timestamp(),
  });

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
    try {
      const driverDoc = await db.collection("user").doc(previousDriverID).get();
      if (driverDoc.exists) {
        const d = driverDoc.data();
        driverName = [d.firstName, d.lastName].filter(Boolean).join(" ").trim() || d.username || previousDriverID;
      }
    } catch { /* fall back to the raw ID above */ }
  }
  createAuditLog({
    action: "update",
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
  if (doc.data().driverID !== driverID) {
    const err = new Error("This booking is not assigned to you.");
    err.status = 403;
    throw err;
  }
  return doc.data();
};

/** A driver's own live trips (upcoming + ongoing), same shape as getDispatchBoard's per-booking entries. */
export const getMyTrips = async (driverID) => {
  if (!driverID) throw new Error("driverID is required.");

  const snaps = await Promise.all(
    DISPATCHABLE_STATUSES.map((s) =>
      db.collection("bookings").where("driverID", "==", driverID).where("status", "==", s).get()
    )
  );

  let bookings = [];
  snaps.forEach((snap) => snap.forEach((doc) => bookings.push({ id: doc.id, ...doc.data() })));

  // withDocs: MyTrips needs to know whether before/after photos already exist
  // so Start Pickup / Return doesn't bounce the driver back to Vehicle
  // Documentation forever. History rows don't need it (skipped there).
  return shapeTripsForDriver(bookings, { withDocs: true });
};

/** A driver's past trips — completed/cancelled/stolen — most recent first. Simple, no pagination (per-driver volume is small). */
export const getMyTripHistory = async (driverID) => {
  if (!driverID) throw new Error("driverID is required.");

  const snaps = await Promise.all(
    ["completed", "cancelled", "stolen"].map((s) =>
      db.collection("bookings").where("driverID", "==", driverID).where("status", "==", s).get()
    )
  );

  let bookings = [];
  snaps.forEach((snap) => snap.forEach((doc) => bookings.push({ id: doc.id, ...doc.data() })));

  const shaped = await shapeTripsForDriver(bookings);
  return shaped.sort((a, b) => (b.startDateTime?.getTime() ?? 0) - (a.startDateTime?.getTime() ?? 0));
};

// Shared shaping for the two driver-facing lists above — same vehicle/
// customer resolution as getDispatchBoard, plus each booking's session
// (for pickupTime/customerDroppedOffAt/returnTime display).
const shapeTripsForDriver = async (bookings, { withDocs = false } = {}) => {
  const carIDs      = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];
  const userIDs     = [...new Set(bookings.map((b) => b.userID).filter(Boolean))];
  const bookingIDs  = [...new Set(bookings.map((b) => b.bookingID || b.id).filter(Boolean))];

  const [vehicleEntries, userEntries, sessions, paymentEntries, beforeDocsEntries, afterDocsEntries] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
    Promise.all(bookings.map((b) => getSessionByBookingID(b.bookingID || b.id).catch(() => null))),
    Promise.all(bookingIDs.map((id) => resolvePaymentInfo(id).then((p) => [id, p]))),
    // Same helpers + same key (bookingID || doc id) as booking.service.js's
    // getAllBookings, so Car Tracking and My Trips agree on "photos done".
    Promise.all(bookingIDs.map((id) => (withDocs ? hasCompleteBeforeTripDocs(id) : Promise.resolve(false)).then((v) => [id, v]))),
    Promise.all(bookingIDs.map((id) => (withDocs ? hasCompleteAfterTripDocs(id)  : Promise.resolve(false)).then((v) => [id, v]))),
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
        pickupTime:           toJSDate(sessions[i]?.data?.pickupTime),
        customerDroppedOffAt: toJSDate(sessions[i]?.data?.customerDroppedOffAt),
        returnTime:           toJSDate(sessions[i]?.data?.returnTime),
        // Set by the customer backend at booking time (see bookingsession.model.js).
        // Null when a session hasn't been created yet / doesn't have coords geocoded.
        pickupLocation:       sessions[i]?.data?.pickupLocation || null,
        dropoffLocation:      sessions[i]?.data?.dropoffLocation || null,
        // Nested to match PaymentStatusModal's `payment` prop shape exactly
        // (see MyTrips.jsx: <PaymentStatusModal payment={paymentTrip?.payment} />).
        payment: { ...payInfo, paymentStatus },
        // Photo checklist state — consumed by MyTrips.jsx handlePickup/handleReturn.
        beforeDocsComplete:   beforeDocsMap[bID] ?? false,
        afterDocsComplete:    afterDocsMap[bID] ?? false,
      };
    })
    .sort((a, b) => (a.startDateTime?.getTime() ?? 0) - (b.startDateTime?.getTime() ?? 0));
};

/** Driver-triggered pickup — ownership-checked, then reuses the same gated updateBooking staff already use (vehicle-docs check included). */
export const driverPickup = async (bookingDocID, driverID) => {
  await assertOwnsBooking(bookingDocID, driverID);
  await updateBooking(bookingDocID, { status: "ongoing" });
  return { id: bookingDocID };
};

/** Driver-triggered drop-off — ownership-checked, then the same rules as the staff dropoff endpoint. */
export const driverDropoff = async (bookingDocID, driverID) => {
  await assertOwnsBooking(bookingDocID, driverID);
  await markBookingDroppedOff(bookingDocID);
  return { id: bookingDocID };
};

/** Driver-triggered return — ownership-checked, then the same gated updateBooking staff use. */
export const driverReturn = async (bookingDocID, driverID) => {
  await assertOwnsBooking(bookingDocID, driverID);
  await updateBooking(bookingDocID, { status: "completed" });
  return { id: bookingDocID };
};

/** Driver receiving cash/in-person payment of the remaining balance — same collectRemainingBalance() staff use on the Payments page, just ownership-checked to the driver's own trip first. */
export const driverCollectBalance = async (bookingDocID, driverID, paymentMethod) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;
  await collectRemainingBalance(bID, driverID, paymentMethod);
  return { id: bookingDocID };
};

/** Driver confirming cash/in-person receipt of the initial payment — same confirmInitialPayment() staff use on the Payments page, just ownership-checked to the driver's own trip first. Lets a driver confirm cash right at pickup without needing Payments page access. */
export const driverConfirmPayment = async (bookingDocID, driverID, paymentMethod) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;
  await confirmInitialPayment(bID, driverID, paymentMethod);
  return { id: bookingDocID };
};

/** Driver confirming they handed a refund-due amount back to the customer (created when a staff discount overshot the balance) — same markRefundIssued() staff use, ownership-checked to the driver's own trip first. The driver is usually the one physically holding the cash. */
export const driverMarkRefundIssued = async (bookingDocID, driverID) => {
  const booking = await assertOwnsBooking(bookingDocID, driverID);
  const bID = booking.bookingID || bookingDocID;
  await markRefundIssued(bID, driverID);
  return { id: bookingDocID };
};