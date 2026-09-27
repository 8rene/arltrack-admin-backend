import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { getSessionByBookingID, markSessionActive, markSessionEnded, markSessionCancelled, markSessionStolen, markDroppedOff } from "../../services/booking/bookingSession.service.js";
import { flushBookingHistory } from "../../services/storage/bookingHistory.service.js";
import { getPhaseChecklist, describeMissingInspection } from "../../services/vehicleDocumentation/vehicleDocumentation.service.js";
import { resolveInspectionReminders } from "../../services/inspectionReminders/inspectionReminders.service.js";
import { computeAmounts, derivePaymentStage } from "../../services/payments/payments.service.js";
import { resolveNotification } from "../../services/notification/notification.service.js";
import { createAuditLog, auditSafe } from "../../services/auditLogs/auditLogs.service.js";
import { listPenaltiesForBooking, settleBooking } from "../../services/penalty/penalty.service.js";
// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export const resolveVehicleName = async (carID) => {
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

// bookingID → { paymentMethod, totalFee, rentalFee, serviceFee,
// extraFee, amountPaid, balance, payType, paymentStatus } from payments
// collection. totalFee comes from payments.amount; the fee breakdown comes
// straight off the same doc. amountPaid/balance/payType are derived via the
// shared computeAmounts() (same logic payments.service.js uses for
// /api/payments), so these numbers can't drift between Bookings, Car
// Tracking, and driver-facing screens. paymentStatus mirrors the "Paid" →
// "Approved" normalization getAllPayments() applies, so badge styling in
// PaymentStatusModal lines up regardless of which endpoint fed it; a
// cancelled *booking* still forces "Cancelled" (applied by the caller,
// which has b.status handy — see getAllBookings below).
const EMPTY_PAYMENT_INFO = {
  paymentMethod: "—", totalFee: 0, rentalFee: 0, serviceFee: 0, extraFee: 0,
  amountPaid: 0, balance: 0, payType: "—", paymentStatus: "—", paymentStage: "—", discountAmount: 0,
  refundDue: 0, refundIssued: false,
};
const resolvePaymentInfo = async (bookingID) => {
  if (!bookingID) return EMPTY_PAYMENT_INFO;
  try {
    const snap = await db.collection("payments")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    if (snap.empty) return EMPTY_PAYMENT_INFO;
    const data = snap.docs[0].data();
    const { amountPaid, balance, payType, refundDue } = computeAmounts(data);
    let paymentStatus = data.status || "Pending";
    if (paymentStatus.toLowerCase() === "paid") paymentStatus = "Approved";
    return {
      paymentMethod: data.paymentMethod || "—",
      totalFee:      data.amount        ?? 0,
      rentalFee:     data.rentalFee     ?? 0,
      serviceFee:    data.serviceFee    ?? 0,
      extraFee:      data.extraFee      ?? 0,
      amountPaid,
      balance,
      payType,
      paymentStatus,
      // Pending / Partial / Completed / Failed / Refunded — the vocabulary staff
      // see. getAllBookings layers "Cancelled" and "For Refund" on top (it knows
      // the booking's status and any open refund request).
      paymentStage: derivePaymentStage(data),
      discountAmount: Number(data.discountAmount) || 0,
      refundDue,
      refundIssued: !!data.refundIssued,
    };
  } catch { return EMPTY_PAYMENT_INFO; }
};

const resolveUserInfo = async (userID) => {
  if (!userID) return { customerName: "—", phone: "—" };
  try {
    const [detailDoc, userDoc] = await Promise.all([
      db.collection("userDetails").doc(userID).get(),
      db.collection("user").doc(userID).get(),
    ]);
    const { firstName = "", lastName = "" } = detailDoc.exists ? detailDoc.data() : {};
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { phone = "—", username = "", email = "" } = userDoc.exists ? userDoc.data() : {};
    const customerName = fullName || username || email || "—";
    return { customerName, phone };
  } catch { return { customerName: "—", phone: "—" }; }
};

const resolveServiceType = async (serviceTypeID) => {
  if (!serviceTypeID) return "—";
  try {
    const doc = await db.collection("serviceType").doc(serviceTypeID).get();
    if (!doc.exists) return "—";
    // The serviceType collection's actual field is `serviceType` (see
    // customer-backend/controllers/services/services.controller.js, which
    // creates/reads this same shape) — not serviceTypeName/name.
    return doc.data().serviceType || "—";
  } catch { return "—"; }
};

// bookingID → { hasHistory, bookingSessionID, lastArchivedAt } — powers the
// "Trip History" row in the Bookings page's detail view, and the deep-link
// into Car Tracking's History tab (see routes/booking/booking.routes.js
// callers). hasHistory is true only once bookingHistory.service.js has
// actually flushed a trail to Storage (archiveUrl set) — a session that
// exists but never got flushed still reports false, same as "no session at
// all", since either way there's nothing in History to show yet.
const EMPTY_HISTORY_INFO = {
  hasHistory: false, bookingSessionID: null, lastArchivedAt: null, pickupTime: null, droppedOffTime: null,
  // { address, lat, lng } | null — set by the customer backend at booking
  // time (see bookingsession.model.js). geofenceZones carries any extra
  // stops the customer selected beyond pickup/dropoff (same field
  // CarTracking's live map and BookingInfoPanel already read) — surfaced
  // here too so Bookings.jsx's detail view can plot every stop on a map,
  // not just the two endpoints.
  pickupLocation: null, dropoffLocation: null, geofenceZones: [],
};
const resolveHistoryInfo = async (bookingID) => {
  if (!bookingID) return EMPTY_HISTORY_INFO;
  try {
    const snap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
    if (snap.empty) return EMPTY_HISTORY_INFO;
    const data = snap.docs[0].data();
    return {
      hasHistory:       !!data.archiveUrl,
      bookingSessionID: data.bookingSessionID || null,
      lastArchivedAt:   data.lastArchivedAt || null,
      // Surfaced here (rather than a separate fetch) since this query
      // already reads the session doc for hasHistory/bookingSessionID —
      // Car Tracking's "Current trip" panel and Bookings.jsx need both to
      // show the Dropped Off marker without an extra round trip per booking.
      pickupTime:       data.pickupTime || null,
      droppedOffTime:   data.droppedOffTime || null,
      pickupLocation:   data.pickupLocation || null,
      dropoffLocation:  data.dropoffLocation || null,
      geofenceZones:    data.geofenceZones || [],
    };
  } catch { return EMPTY_HISTORY_INFO; }
};

// ─────────────────────────────────────────────
// Archive to notificationsArchive when booking status resolves
// (Frontend reads live from bookings collection directly)
// ─────────────────────────────────────────────
const archiveNotification = async ({ userID, bookingID, docID, oldStatus, newStatus, bookingData }) => {
  try {
    await db.collection("notificationsArchive").add({
      bookingDocID:   docID,
      bookingID:      bookingID || docID,
      userID:         userID || "",
      previousStatus: oldStatus || "",
      resolvedStatus: newStatus || "",
      startDateTime:  bookingData.startDateTime  || null,
      endDateTime:    bookingData.endDateTime    || null,
      carID:          bookingData.carID          || "",
      location:       bookingData.location       || "",
      notesAdmin:     bookingData.notesAdmin     || "",
      archivedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[ARCHIVE] Notification archived for booking:", bookingID);
  } catch (err) {
    console.error("[ARCHIVE] Failed:", err.message);
  }
};



// ─────────────────────────────────────────────
// Main service functions
// ─────────────────────────────────────────────

export const getAllBookings = async (statusFilter) => {
  const filter = statusFilter?.toLowerCase();

  let rows = [];
  const seen = new Set();
  const addSnap = (snap) => snap.forEach((doc) => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    rows.push({ id: doc.id, ...doc.data() });
  });

  if (!filter || filter === "all") {
    // "to pay" = created but the deposit hasn't cleared yet. Shown (read-only, badge
    // in the UI) so staff can see what's pending and that the car is spoken for.
    const statuses = ["to pay", "upcoming", "ongoing", "completed", "cancelled", "cancellation_request", "stolen"];
    const snaps = await Promise.all(
      statuses.map((st) => db.collection("bookings").where("status", "==", st).get())
    );
    snaps.forEach(addSnap);
  } else if (filter === "cancellation_request") {
    // Two shapes exist: the older one (status itself flipped to "cancellation_request")
    // and the customer app's current one (status stays "ongoing", with
    // cancellationRequestStatus: "pending" on the booking).
    const [legacy, current] = await Promise.all([
      db.collection("bookings").where("status", "==", "cancellation_request").get(),
      db.collection("bookings").where("cancellationRequestStatus", "==", "pending").get(),
    ]);
    addSnap(legacy); addSnap(current);
  } else {
    addSnap(await db.collection("bookings").where("status", "==", filter).get());
  }

  // A booking with a pending cancellation request is PRESENTED as
  // "cancellation_request" (the value the Bookings page already knows how to
  // show and act on) while its real status is kept as actualStatus. Without this
  // the customer's requests were invisible: the page looked for a status the
  // customer app no longer sets.
  rows = rows.map((b) =>
    b.cancellationRequestStatus === "pending" && (b.status || "").toLowerCase() !== "cancelled"
      ? { ...b, actualStatus: b.status, status: "cancellation_request" }
      : b
  );
  if (filter && filter !== "all") rows = rows.filter((b) => (b.status || "").toLowerCase() === filter);

  rows.sort((a, b) => {
    const ta = a.updatedAt?.toMillis?.() ?? 0;
    const tb = b.updatedAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  // Bookings that have a refund request in flight → shown as "For Refund".
  const openRefundSnap = await db.collection("refundRequests").where("status", "in", ["Pending", "Approved"]).get();
  const bookingsWithOpenRefund = new Set(openRefundSnap.docs.map((d) => d.data().bookingID));

  const carIDs         = [...new Set(rows.map((b) => b.carID).filter(Boolean))];
  const bookingIDs     = [...new Set(rows.map((b) => b.bookingID || b.id).filter(Boolean))];
  const userIDs        = [...new Set(rows.map((b) => b.userID).filter(Boolean))];
  const serviceTypeIDs = [...new Set(rows.map((b) => b.serviceTypeID).filter(Boolean))];
  // Chauffeur bookings carry driverID once driverDispatch.assignDriver()
  // has run (see that service) — resolved the same way as the customer
  // (userDetails + user collections) so Bookings.jsx can show who's
  // actually driving, or that no one's assigned yet, without a separate
  // Driver Dispatch lookup.
  const driverIDs      = [...new Set(rows.map((b) => b.driverID).filter(Boolean))];

  const [vehicleEntries, paymentEntries, userEntries, driverEntries, serviceTypeEntries, historyEntries, beforeDocsEntries, afterDocsEntries] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(bookingIDs.map((id) => resolvePaymentInfo(id).then((p) => [id, p]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
    Promise.all(driverIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
    Promise.all(serviceTypeIDs.map((id) => resolveServiceType(id).then((s) => [id, s]))),
    Promise.all(bookingIDs.map((id) => resolveHistoryInfo(id).then((h) => [id, h]))),
    Promise.all(bookingIDs.map((id) => getPhaseChecklist(id, "before").then((v) => [id, v]))),
    Promise.all(bookingIDs.map((id) => getPhaseChecklist(id, "after").then((v) => [id, v]))),
  ]);

  const vehicleMap     = Object.fromEntries(vehicleEntries);
  const paymentMap     = Object.fromEntries(paymentEntries);
  const userMap        = Object.fromEntries(userEntries);
  const driverMap      = Object.fromEntries(driverEntries);
  const serviceTypeMap = Object.fromEntries(serviceTypeEntries);
  const historyMap     = Object.fromEntries(historyEntries);
  const beforeDocsMap  = Object.fromEntries(beforeDocsEntries);
  const afterDocsMap   = Object.fromEntries(afterDocsEntries);

  return rows.map((b) => {
    const bID     = b.bookingID || b.id;
    const payInfo = paymentMap[bID] || EMPTY_PAYMENT_INFO;
    const histInfo = historyMap[bID] || { hasHistory: false, bookingSessionID: null, lastArchivedAt: null, pickupTime: null, droppedOffTime: null };
    // A cancelled booking always shows "Cancelled" payment status, matching
    // getAllPayments()'s override — the underlying payment doc's own status
    // (e.g. still "Pending") isn't what matters once the trip itself is off.
    // …EXCEPT a payment that was actually refunded: that stays "Refunded" (it used
    // to be hidden behind "Cancelled", losing the fact that the money went back).
    const isCancelled = (b.status || "").toLowerCase() === "cancelled";
    const paymentStatus = isCancelled && payInfo.paymentStatus !== "Refunded" ? "Cancelled" : payInfo.paymentStatus;
    let paymentStage = payInfo.paymentStage;
    if (paymentStage !== "Refunded") {
      if (bookingsWithOpenRefund.has(bID)) paymentStage = "For Refund";
      else if (isCancelled) paymentStage = "Cancelled";
    }
    return {
      ...b,
      vehicleName:      vehicleMap[b.carID] || "—",
      paymentMethod:    payInfo.paymentMethod,
      totalFee:         payInfo.totalFee,        // from payments.amount
      rentalFee:        payInfo.rentalFee,
      serviceFee:       payInfo.serviceFee,
      extraFee:         payInfo.extraFee,
      amountPaid:       payInfo.amountPaid,
      balance:          payInfo.balance,
      payType:          payInfo.payType,
      discountAmount:   payInfo.discountAmount,
      paymentStatus,
      paymentStage,
      customerName:     userMap[b.userID]?.customerName || "—",
      phone:            userMap[b.userID]?.phone || "—",
      // No driverID at all (e.g. self-drive, or a chauffeur booking not yet
      // assigned) → driverName stays null so the UI can say "No driver
      // assigned" instead of a misleading "—".
      driverID:         b.driverID || null,
      driverName:       b.driverID ? (driverMap[b.driverID]?.customerName || "—") : null,
      driverPhone:      b.driverID ? (driverMap[b.driverID]?.phone || "—") : null,
      serviceTypeName:  serviceTypeMap[b.serviceTypeID] || "—",
      hasHistory:       histInfo.hasHistory,
      bookingSessionID: histInfo.bookingSessionID,
      lastArchivedAt:   histInfo.lastArchivedAt,
      pickupTime:           histInfo.pickupTime,
      droppedOffTime:       histInfo.droppedOffTime,
      // Every stop for this booking's trip — pickup, dropoff, and any
      // extra stops selected at booking time — so the detail view can
      // plot them on a map instead of just printing the address string.
      pickupLocation:   histInfo.pickupLocation,
      dropoffLocation:  histInfo.dropoffLocation,
      geofenceZones:    histInfo.geofenceZones,
      // Device-check requirement (see markDeviceChecked below) — lives
      // directly on the booking doc since it's a one-off staff checkbox,
      // not something with its own collection.
      deviceCheckedAt:  b.deviceCheckedAt || null,
      deviceCheckNote:  b.deviceCheckNote || "",
      // "Complete" now means photos AND the parts-condition record — see
      // getPhaseChecklist in vehicleDocumentation.service.js. The
      // per-half breakdown is included for UIs that want to say which half
      // is still missing.
      beforeDocsComplete: beforeDocsMap[bID]?.complete ?? false,
      afterDocsComplete:  afterDocsMap[bID]?.complete ?? false,
      beforeInspection:   beforeDocsMap[bID] ?? { photos: false, parts: false, complete: false },
      afterInspection:    afterDocsMap[bID] ?? { photos: false, parts: false, complete: false },
    };
  });
};

export const updateBooking = async (docID, updates, performedBy = null) => {
  const doc = await db.collection("bookings").doc(docID).get();
  if (!doc.exists) throw new Error("Booking not found");

  const bookingData = doc.data();
  const { status: oldStatus, userID, carID, bookingID } = bookingData;

  const nonEditable = ["completed", "cancelled", "stolen"]; // once flagged stolen, no further edits through this endpoint
  if (nonEditable.includes(oldStatus?.toLowerCase())) {
    throw new Error(`Cannot edit a booking with status: ${oldStatus}`);
  }

  const allowed = ["location", "startDateTime", "endDateTime", "notesAdmin", "notesUser", "status"];
  const filtered = {};
  allowed.forEach((k) => {
    if (updates[k] !== undefined) {
      filtered[k] = k === "status" ? updates[k].toLowerCase() : updates[k];
    }
  });

  // ── Payment validation: cannot mark picked-up/ongoing if payment is not yet approved/paid ──
  if (filtered.status === "ongoing" && oldStatus?.toLowerCase() !== "ongoing") {
    const bID = bookingID || docID;
    const paySnap = await db.collection("payments")
      .where("bookingID", "==", bID)
      .limit(1)
      .get();

    if (paySnap.empty) {
      throw new Error("Cannot approve booking: no payment record found for this booking.");
    }

    const paymentData = paySnap.docs[0].data();
    const payStatus   = paymentData.status || "";
    const approvedStatuses = ["approved", "paid"];

    if (!approvedStatuses.includes(payStatus.toLowerCase())) {
      throw new Error(
        `Cannot approve booking: payment is still "${payStatus}". ` +
        `Please approve the payment first in the Payments page.`
      );
    }

    // Balance must also be fully settled — this is a stricter rule than
    // before. Previously an approved deposit with balance > 0 was enough
    // to reach "ongoing"; now Pickup is blocked until the full balance is
    // collected (discounts included — applying a discount lowers this
    // balance the same way a payment does).
    const { balance } = computeAmounts(paymentData);
    if (balance > 0) {
      throw new Error(
        `Cannot approve booking: payment still requires action — ₱${balance.toLocaleString()} remaining. ` +
        `Collect or apply a discount for the remaining balance first.`
      );
    }
  }

  // ── Vehicle inspection validation: cannot mark picked-up/ongoing until
  // the before-trip inspection is complete — the 3 exterior photos AND the
  // parts-condition record, both entered by staff (drivers can't write
  // either, see vehicleDocumentation.routes.js). This is the real gate the
  // driver's Start Pickup goes through; the My Trips button state is just a
  // convenience mirror of it. ──
  if (filtered.status === "ongoing" && oldStatus?.toLowerCase() !== "ongoing") {
    const bID = bookingID || docID;
    const checklist = await getPhaseChecklist(bID, "before");
    if (!checklist.complete) {
      throw new Error(
        `Cannot mark picked up: the before-trip vehicle inspection is incomplete — still missing ${describeMissingInspection(checklist)}. ` +
        "A supervisor needs to complete it in Vehicle Inspections first."
      );
    }
  }

  // ── Vehicle inspection validation: cannot mark completed/returned until
  // the after-trip inspection is complete (photos AND parts condition).
  // Mirrors the before-trip guard above so Return can't skip the
  // inspection the same way Pickup can't. ──
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    const bID = bookingID || docID;
    const checklist = await getPhaseChecklist(bID, "after");
    if (!checklist.complete) {
      throw new Error(
        `Cannot mark returned: the after-trip vehicle inspection is incomplete — still missing ${describeMissingInspection(checklist)}. ` +
        "A supervisor needs to complete it in Vehicle Inspections first."
      );
    }
  }

  // ── Vehicle drop-off validation: cannot mark completed/returned until
  // someone (the assigned driver, or a supervisor/staff for a no-driver
  // booking) has marked the vehicle itself physically dropped off. This is
  // the checkpoint that unblocks the after-trip inspection in the first
  // place — a supervisor can't meaningfully inspect a car that, per the
  // system, hasn't arrived yet. ──
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    const bID = bookingID || docID;
    const session = await getSessionByBookingID(bID);
    if (!session?.data?.droppedOffTime) {
      throw new Error(
        "Cannot mark returned: the vehicle hasn't been marked dropped off yet. " +
        "Mark it dropped off first, then complete the after-trip inspection."
      );
    }
  }

  // ── Penalty validation: cannot mark completed/returned while any
  // penalty on this booking is still a Draft (awaiting confirm/void/waive)
  // or a Confirmed penalty still has an outstanding balance. Deliberately
  // no override here — a supervisor has to resolve or explicitly pay off
  // every open line item before Return will go through. ──
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    const bID = bookingID || docID;
    const penalties = await listPenaltiesForBooking(bID);
    const openDraft   = penalties.filter((p) => p.status === "Draft");
    const openUnpaid  = penalties.filter((p) => p.status === "Confirmed" && (p.paidAmount || 0) < (p.amount || 0));
    if (openDraft.length || openUnpaid.length) {
      throw new Error(
        "Cannot mark returned: this booking still has unresolved penalties " +
        `(${openDraft.length} awaiting confirm/void/waive, ${openUnpaid.length} confirmed but not yet paid). ` +
        "Resolve every penalty on this booking first."
      );
    }
  }

  // ── Device-check validation: cannot mark completed/returned until staff
  // have confirmed the GPS device status on this car at return (see
  // markDeviceChecked below). This is a required note, not an actual
  // gpsDevice unassignment — the device itself normally stays mounted
  // on the car between rentals; this just records that someone actually
  // looked at it before the car goes back out. ──
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    if (!bookingData.deviceCheckedAt) {
      throw new Error(
        "Cannot mark returned: the GPS device check hasn't been recorded for this booking yet."
      );
    }
  }

  // Stamp the actual return moment, once, at the exact instant Return is
  // clicked (ongoing -> completed). This is deliberately a server
  // timestamp on THIS transition only — never editable afterward (this
  // endpoint already blocks further edits to a "completed" booking via
  // the nonEditable guard above) and never derived from GPS. Note this is
  // NOT the same moment as droppedOffTime above — the vehicle can sit
  // dropped-off for a while going through inspection/penalty/device-check
  // before Return is actually confirmed.
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    filtered.returnedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  filtered.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  await db.collection("bookings").doc(docID).update(filtered);

  // Deduct every confirmed, unpaid penalty from the held deposit now that
  // Return has actually gone through — settleBooking() itself still
  // refuses if a draft penalty somehow slipped through or the deposit was
  // already settled, so this is a safety net, not the only guard. Best
  // effort: the booking has already been marked returned above (that part
  // is done and correct regardless), so a settlement hiccup here gets
  // logged for a supervisor to sort out manually via the Penalties page
  // rather than un-completing a booking that's already physically returned.
  if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    const bID = bookingID || docID;
    // depositReturnMethod/-ReferenceNumber only matter when a refund is
    // actually owed to the customer (net > 0) — the Return confirm panel
    // asks for these up front so settleBooking never has to guess a
    // method for money that's actually changing hands. If nothing owed,
    // these are simply unused inside settleBooking.
    settleBooking({
      bookingID: bID,
      actorUid: performedBy,
      returnMethod: updates.depositReturnMethod || "InStore",
      returnReferenceNumber: updates.depositReturnReferenceNumber || "",
    }).catch((err) =>
      console.error(`[Booking] settleBooking failed for ${bID} after Return:`, err.message)
    );
  }

  // The booking has moved on, so any "driver is waiting on the inspection"
  // reminder for it is stale: pickup clears the pickup one, and once the
  // trip is completed/cancelled/stolen nothing is left to remind about.
  // Best-effort — never blocks the status change itself.
  if (filtered.status && filtered.status !== oldStatus?.toLowerCase()) {
    const reminderKey = bookingID || docID;
    const stalePhases =
      filtered.status === "ongoing" ? ["before"]
      : ["completed", "cancelled", "stolen"].includes(filtered.status) ? ["before", "after"]
      : [];
    if (stalePhases.length) {
      resolveInspectionReminders(reminderKey, stalePhases).catch((err) =>
        console.error("[Booking] Failed to resolve inspection reminders:", err.message)
      );
    }
  }

  // ── Link booking status transitions to the GPS session lifecycle ──
  // "ongoing" = pickup happened, car is now actually on the trip. This is
  // the one place that status-vocabulary decision actually takes effect —
  // flagging it here rather than silently assuming it, since it was still
  // an open question. Session activation/ending is best-effort: a failure
  // here must never block the booking status update itself, since staff
  // still need to be able to mark a car picked up/returned even if the
  // Firestore session link is temporarily unavailable.
  if (filtered.status === "ongoing" && oldStatus?.toLowerCase() !== "ongoing") {
    const bID = bookingID || docID;
    createAuditLog({
      action: "update",
      userID: performedBy,
    }).catch((err) => console.error("[AuditLog] Pickup log failed:", err.message));
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionActive(session.data.bookingSessionID, carID);
        // Flush right away too — mostly just so a file actually shows up in
        // Storage the moment tracking starts, as reassurance the pipeline is
        // wired correctly, rather than only ever appearing at Return or
        // whenever tonight's cron happens to run. It'll be near-empty at
        // this exact instant (no GPS pings have landed yet), and gets
        // overwritten with the real trail as the trip progresses and again
        // at Return — this first flush is just an early proof-of-life, not
        // the final archive.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Pickup flush failed (session still marked active, cron will retry tonight):", flushErr.message);
        }
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — GPS tracking won't start for this trip.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to activate GPS session:", err.message);
    }
  } else if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    const bID = bookingID || docID;
    createAuditLog({
      action: "update",
      userID: performedBy,
    }).catch((err) => console.error("[AuditLog] Return log failed:", err.message));
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionEnded(session.data.bookingSessionID);
        // Flush the full trail to Storage right now — this is the "Return"
        // action, no reason to make the history file wait for tonight's
        // cron when the trip is already over.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Return flush failed (session still marked ended, cron will retry tonight):", flushErr.message);
        }
      }
    } catch (err) {
      console.error("[Booking] Failed to end GPS session:", err.message);
    }
  } else if (filtered.status === "cancelled" && oldStatus?.toLowerCase() !== "cancelled") {
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionCancelled(session.data.bookingSessionID);
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — nothing to cancel.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to cancel GPS session:", err.message);
    }
  } else if (filtered.status === "stolen" && oldStatus?.toLowerCase() !== "stolen") {
    // Manual only — set by staff hitting "Stolen" on the car card. No
    // auto-trigger off geofence breach.
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionStolen(session.data.bookingSessionID);
        // Same as Return — flush the trail immediately for documentation
        // rather than waiting for the nightly cron. This is manual/admin-
        // triggered, so there's no reason to delay the record.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Stolen flush failed (session still marked stolen, cron will retry tonight):", flushErr.message);
        }
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — cannot flag session stolen.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to flag session stolen:", err.message);
    }
  }

  // ── Archive + auto-delete notification when booking moves out of pending/cancellation_request ──
  const newStatus = filtered.status;
  const activeStatuses = ["upcoming", "cancellation_request"];
  const resolvedStatuses = ["upcoming", "ongoing", "completed", "cancelled", "stolen"];
  if (
    newStatus &&
    newStatus !== oldStatus?.toLowerCase() &&
    activeStatuses.includes(oldStatus?.toLowerCase()) &&
    resolvedStatuses.includes(newStatus)
  ) {
    await archiveNotification({
      userID,
      bookingID: bookingID || docID,
      docID,
      oldStatus: oldStatus?.toLowerCase(),
      newStatus,
      bookingData,
    });

    // Delete corresponding notifications from the notifications collection
    try {
      const bID = bookingID || docID;
      const notifSnap = await db.collection("notifications")
        .where("bookingID", "==", bID)
        .where("type", "==", "new_booking")
        .get();
      if (!notifSnap.empty) {
        const batch = db.batch();
        notifSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        console.log(`[NOTIF] Auto-deleted ${notifSnap.size} new_booking notif(s) for booking: ${bID}`);
      }
    } catch (err) {
      console.error("[NOTIF] Failed to delete booking notifications:", err.message);
    }
  }

  return { success: true };
};

// ─────────────────────────────────────────────
// Mark the vehicle itself physically dropped off — every booking type,
// not just chauffeur. Distinct from Return: the session stays "active",
// only the timestamp changes, and Return itself stays blocked until
// inspection/penalties/device-check are also cleared (see updateBooking's
// "completed" gates above). See bookingsession.model.js for why this is
// never auto-filled/backfilled.
// ─────────────────────────────────────────────
export const markBookingDroppedOff = async (docID, performedBy = null) => {
  const bookingRef = db.collection("bookings").doc(docID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (booking.status?.toLowerCase() !== "ongoing") {
    throw new Error(`Cannot mark dropped off: booking status is "${booking.status}", not "ongoing" (has it been picked up yet?).`);
  }

  const bID = booking.bookingID || docID;
  const session = await getSessionByBookingID(bID);
  if (!session) throw new Error("No active trip session found for this booking.");
  if (session.data.droppedOffTime) {
    throw new Error("Already marked dropped off — this can't be re-triggered or edited.");
  }

  await markDroppedOff(session.ref.id);
  createAuditLog({
    action: "update",
    userID: performedBy,
    bookingID: bID,
    description: `Marked vehicle dropped off on booking ${bID}.`,
  }).catch((err) => console.error("[AuditLog] Dropoff log failed:", err.message));
  return { id: docID };
};

// ─────────────────────────────────────────────
// Device-check requirement at Return. This is a required NOTE, not an
// actual GPS device unassignment — it does not touch the gpsDevice
// collection at all (a real unassign is a separate, deliberate action on
// the GPS Devices page, and unassigning there detaches the tracker from
// the CAR, affecting every future booking for it, not just this trip).
// This just records that a human actually checked the device before the
// car goes back out, and blocks Return until they have. One-shot, same
// as drop-off: once recorded it isn't editable through this endpoint.
// ─────────────────────────────────────────────
export const markDeviceChecked = async (docID, note = "", performedBy = null) => {
  const bookingRef = db.collection("bookings").doc(docID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (booking.status?.toLowerCase() !== "ongoing") {
    throw new Error(`Cannot record device check: booking status is "${booking.status}", not "ongoing".`);
  }
  if (booking.deviceCheckedAt) {
    throw new Error("Device check already recorded for this booking — this can't be re-triggered or edited.");
  }

  await bookingRef.update({
    deviceCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
    deviceCheckedBy: performedBy,
    deviceCheckNote: note || "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const bID = booking.bookingID || docID;
  createAuditLog({
    action: "update",
    userID: performedBy,
    bookingID: bID,
    description: `Recorded GPS device check on booking ${bID}${note ? `: ${note}` : "."}`,
  }).catch((err) => console.error("[AuditLog] Device check log failed:", err.message));

  return { id: docID };
};

// ─────────────────────────────────────────────
// Read-only pre-return checklist — never blocks anything, just reports
// where a booking stands against every Return requirement, so the
// frontend can show a "here's what's still missing" panel instead of a
// disabled/greyed-out button. The actual enforcement lives in
// updateBooking's "completed" gates above; this is purely a mirror of
// those same checks for display purposes.
// ─────────────────────────────────────────────
export const getReturnChecklist = async (docID) => {
  const bookingRef = db.collection("bookings").doc(docID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();
  const bID = booking.bookingID || docID;

  const [session, afterChecklist, penalties, paymentSnap] = await Promise.all([
    getSessionByBookingID(bID),
    getPhaseChecklist(bID, "after"),
    listPenaltiesForBooking(bID),
    db.collection("payments").where("bookingID", "==", bID).limit(1).get(),
  ]);
  const depositHeld = paymentSnap.empty ? null : (paymentSnap.docs[0].data().deposit?.amount ?? null);

  const draftPenalties = penalties.filter((p) => p.status === "Draft");
  const unpaidPenalties = penalties.filter((p) => p.status === "Confirmed" && (p.paidAmount || 0) < (p.amount || 0));

  const items = [
    {
      key: "droppedOff",
      label: "Vehicle dropped off",
      complete: !!session?.data?.droppedOffTime,
      detail: session?.data?.droppedOffTime ? null : "Nobody has marked the vehicle physically dropped off yet.",
    },
    {
      key: "inspection",
      label: "After-trip vehicle inspection",
      complete: !!afterChecklist.complete,
      detail: afterChecklist.complete ? null : `Still missing ${describeMissingInspection(afterChecklist)}.`,
    },
    {
      key: "penalties",
      label: "Penalties resolved",
      complete: draftPenalties.length === 0 && unpaidPenalties.length === 0,
      detail: (draftPenalties.length || unpaidPenalties.length)
        ? `${draftPenalties.length} awaiting confirm/void/waive, ${unpaidPenalties.length} confirmed but not yet paid.`
        : null,
    },
    {
      key: "deviceCheck",
      label: "GPS device check",
      complete: !!booking.deviceCheckedAt,
      detail: booking.deviceCheckedAt ? null : "The GPS device hasn't been checked for this booking yet.",
    },
  ];

  return {
    bookingID: bID,
    canReturn: items.every((i) => i.complete),
    items,
    driverID: booking.driverID || null,
    depositHeld,
    penalties,
  };
};

// ─────────────────────────────────────────────
// Approve / reject a pending cancellation_request — the customer-side
// counterpart of this lives in customer-backend's requestCancellation()
// (bookings.controller.js), which is the only thing that ever sets a
// booking to "cancellation_request" in the first place. bookingWatcher.js
// used to auto-resolve the notification when status left that state;
// now that the watcher is gone, these two actions resolve it directly,
// same pattern as every other direct-write notification in this codebase.
// ─────────────────────────────────────────────

// True for either shape of a pending cancellation request — see getAllBookings.
const hasPendingCancellationRequest = (booking) =>
  booking.cancellationRequestStatus === "pending" || (booking.status || "").toLowerCase() === "cancellation_request";

export const approveCancellationRequest = async (docID, performedBy = null) => {
  const bookingRef = db.collection("bookings").doc(docID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (!hasPendingCancellationRequest(booking)) {
    throw new Error(`Cannot approve: booking ${docID} has no pending cancellation request (status is "${booking.status}").`);
  }

  const now = new Date();
  await bookingRef.update({
    status: "cancelled",
    cancellationRequestStatus: "approved",
    statusBeforeCancellationRequest: admin.firestore.FieldValue.delete(),
    updatedAt: now,
  });

  // Mirror onto the session doc, same as the customer's own instant-cancel
  // path already does for "upcoming" bookings — this one is "ongoing", so
  // there's a real active session to close out here.
  try {
    const bID = booking.bookingID || docID;
    const session = await getSessionByBookingID(bID);
    if (session) {
      await markSessionCancelled(session.ref.id);
    }
  } catch (err) {
    console.error("[BOOKINGS] approveCancellationRequest: failed to sync bookingSession:", err.message);
  }

  // Resolves every Owner/Admin/Supervisor's own copy of this notification
  // at once — see notification.service.js's resolveNotification() header
  // comment for why no userID filter is needed here.
  await resolveNotification("cancellation_request", docID).catch((err) =>
    console.error("[BOOKINGS] approveCancellationRequest: failed to resolve notification:", err.message)
  );

  auditSafe({
    action: "update",
    description: `Cancellation request for booking ${booking.bookingID || docID} APPROVED — booking cancelled.`,
    userID: performedBy,
    bookingID: booking.bookingID || docID,
  });

  return { id: docID, status: "cancelled" };
};

export const rejectCancellationRequest = async (docID, rejectReason, performedBy = null) => {
  const bookingRef = db.collection("bookings").doc(docID);
  const bookingDoc = await bookingRef.get();
  if (!bookingDoc.exists) throw new Error("Booking not found.");
  const booking = bookingDoc.data();

  if (!hasPendingCancellationRequest(booking)) {
    throw new Error(`Cannot reject: booking ${docID} has no pending cancellation request (status is "${booking.status}").`);
  }

  // Older shape: status itself was flipped, so restore what it was before the
  // request (falls back to "ongoing", the only status this request is ever
  // entered from). Current shape: status never changed, nothing to restore.
  const wasLegacy = (booking.status || "").toLowerCase() === "cancellation_request";
  const revertTo = wasLegacy ? (booking.statusBeforeCancellationRequest || "ongoing") : booking.status;

  const now = new Date();
  await bookingRef.update({
    status: revertTo,
    // "rejected" (not "pending") — the customer app only blocks a NEW request while
    // one is "pending", so they can ask again if they need to.
    cancellationRequestStatus: "rejected",
    statusBeforeCancellationRequest: admin.firestore.FieldValue.delete(),
    cancellationRejectReason: rejectReason || "",
    updatedAt: now,
  });

  await resolveNotification("cancellation_request", docID).catch((err) =>
    console.error("[BOOKINGS] rejectCancellationRequest: failed to resolve notification:", err.message)
  );

  auditSafe({
    action: "update",
    description: `Cancellation request for booking ${booking.bookingID || docID} REJECTED${rejectReason ? `: ${rejectReason}` : ""}.`,
    userID: performedBy,
    bookingID: booking.bookingID || docID,
  });

  return { id: docID, status: revertTo };
};