import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { notifyStaff, resolveNotification, createNotification } from "../notification/notification.service.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";
import { getPaymentBreakdown, resolvePaymongoIDs } from "./paymentBreakdown.js";

// Customer-facing bell notification — mirrors the helper of the same name
// in refundRequest.service.js. No-ops quietly if there's no userID on the
// payment record (shouldn't happen, but this is a side-effect, not the
// main flow, so it shouldn't be able to fail the discount itself).
const notifyCustomer = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[PAYMENTS] failed to notify customer (${type}):`, err.message));
};

// Single-person bell notification (used for the driver ping below) — same
// shape as notifyCustomer, kept separate since "driver" isn't "customer"
// even though the underlying write is identical.
const notifyPerson = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[PAYMENTS] failed to notify ${userID} (${type}):`, err.message));
};

// Looks up a booking by its bookingID (not the Firestore doc id) — used by
// applyDiscount() for the chauffeur/driver checks, and doubles as the
// fallback source for the customer's userID (see resolveCustomerUserID).
const findBookingByBookingID = async (bookingID) => {
  const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
};

// Resolves the customer's userID for a booking. Payment docs carry their
// own userID field, but it isn't reliably populated on every record —
// getAllPayments()/buildPaymentRow() above deliberately resolve
// customerName from the BOOKING's userID rather than the payment's, for
// the same reason. Bell notifications need a real userID to land on
// anyone, so this prefers the payment doc's value (no extra read) and
// falls back to the already-fetched booking doc if that's missing.
const resolveCustomerUserID = (paymentUserID, bookingData) => paymentUserID || bookingData?.userID || null;

// resolve customer name: firstName+lastName (priority), fallback to username
const resolveCustomerName = async (userID) => {
  if (!userID) return "—";
  try {
    // Try userDetails first for firstName + lastName
    const snap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!snap.empty) {
      const { firstName = "", lastName = "" } = snap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }
    // Fallback: username from user collection (skip redundant userDetails doc fetch)
    const userDoc = await db.collection("user").doc(userID).get();
    if (userDoc.exists) {
      const { username = "", email = "" } = userDoc.data();
      return username || email || "—";
    }
    return "—";
  } catch { return "—"; }
};

// carID → vehicle name from cars → model → brand
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

// The customer app and the webhook write payment.status in lowercase
// ("pending", "paid", "failed") while the admin side writes capitalized
// values ("Approved", "Rejected", ...) and the Refunded status is set by
// the PayMongo webhook. Everything the admin UI compares against
// ("Pending", "Approved", "Refunded", ...) expects ONE canonical spelling,
// so every payment returned by this service goes through this first.
// "paid" (PayMongo auto-confirmed) is shown as "Approved".
const CANONICAL_STATUS = {
  pending:   "Pending",
  paid:      "Approved",
  approved:  "Approved",
  rejected:  "Rejected",
  cancelled: "Cancelled",
  canceled:  "Cancelled",
  failed:    "Failed",
  refunded:  "Refunded",
};
export const normalizePaymentStatus = (raw) => {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "Pending";
  return CANONICAL_STATUS[key] || String(raw);
};

// The only modes staff/drivers can pick when confirming a cash/in-person
// payment (initial or balance) — matches the dropdown in PaymentStatusModal.
// Kept as an explicit whitelist rather than trusting whatever string the
// frontend sends, since this ends up on the books (payment doc + transaction
// log) and free text there invites "gcash"/"GCash"/"G-Cash" drift.
export const PAYMENT_METHODS = ["Cash", "GCash", "Bank Transfer"];

const assertValidPaymentMethod = (method) => {
  if (!PAYMENT_METHODS.includes(method)) {
    throw new Error(`paymentMethod must be one of: ${PAYMENT_METHODS.join(", ")}.`);
  }
};

// Compute amountPaid and balance based on methodOfPayment (the payment type field)
//
// The math now lives in ./paymentBreakdown.js — an identical copy of the customer
// backend's utils/payments/paymentBreakdown.util.js, so BOTH apps always agree on
// what has been paid. This keeps the exact same return shape and legacy
// behaviour (status gating, Partial = floor(50%), balanceCollected, staff
// discount + refundDue), and additionally understands the balance the
// customer paid ONLINE (balanceStatus: "paid") — which the old version ignored,
// so a Partial booking fully paid through PayMongo still showed a balance owed,
// blocked pickup, and invited staff to collect the same money in cash twice.
export const computeAmounts = (payment) => {
  const { amountPaid, balance, payType, refundDue } = getPaymentBreakdown(payment);
  return { amountPaid, balance, payType, refundDue };
};

// Same lookup the rest of the file needs in several places: is there a refund
// request in flight for this payment? (Pending = awaiting review, Approved =
// PayMongo/cash return still being completed.)
const OPEN_REFUND_STATUSES = ["Pending", "Approved"];
const findOpenRefundRequest = async (paymentID) => {
  if (!paymentID) return null;
  const snap = await db.collection("refundRequests")
    .where("paymentID", "==", paymentID)
    .where("status", "in", OPEN_REFUND_STATUSES)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
};

// The label staff see. DERIVED at read time from what's on the doc — stored
// values are untouched, so no data migration is needed and nothing that still
// compares against the raw status strings breaks. "Approved" is gone from what
// staff see: it just meant "paid" (PayMongo) or "confirmed by staff" (cash).
//
//   Pending    nothing received yet
//   Partial    deposit received, balance still owed
//   Completed  fully paid
//   For Refund a refund request is Pending/Approved for this payment
//   Refunded   the money went back (wins over Cancelled)
//   Cancelled  booking/payment cancelled
//   Failed     failed / rejected
export const derivePaymentStage = (payment, { bookingStatus = "", hasOpenRefund = false } = {}) => {
  const status = String(payment.status || "").toLowerCase();
  if (status === "refunded") return "Refunded";
  if (hasOpenRefund) return "For Refund";
  if (String(bookingStatus).toLowerCase() === "cancelled" || status === "cancelled" || status === "canceled") return "Cancelled";
  if (status === "failed" || status === "rejected") return "Failed";
  const confirmed = status === "paid" || status === "approved" || !!payment.balanceCollected;
  if (!confirmed) return "Pending";
  const { balance } = getPaymentBreakdown(payment);
  return balance > 0 ? "Partial" : "Completed";
};

const isoOf = (t) => (t?.toDate ? t.toDate().toISOString() : t instanceof Date ? t.toISOString() : null);

// One place that shapes a payment for the admin UI (used by list + detail).
const buildPaymentRow = (payment, booking, customerName, vehicleName, openRefund) => {
  const { amountPaid, balance, payType, refundDue } = computeAmounts(payment);
  const bookingStatus = (booking.status || "").toLowerCase();

  // Raw-status field the older screens still compare against. A cancelled
  // booking shows "Cancelled" — EXCEPT a payment that was actually refunded,
  // which must stay "Refunded" (it used to be overwritten by "Cancelled",
  // hiding the fact that the money had been returned).
  let status = normalizePaymentStatus(payment.status);
  if (bookingStatus === "cancelled" && status !== "Refunded") status = "Cancelled";

  const paymongoIDs = resolvePaymongoIDs(payment);
  const paymentStage = derivePaymentStage(payment, { bookingStatus, hasOpenRefund: !!openRefund });

  return {
    id: payment.id,
    paymentID: payment.paymentID || payment.id,
    bookingID: payment.bookingID || "—",
    customerName,
    vehicleName,
    totalFee: Number(payment.amount) || 0,
    amountPaid,
    balance,
    payType,
    discountAmount: Number(payment.discountAmount) || 0,
    discountReason: payment.discountReason || "",
    refundDue: refundDue,
    refundIssued: !!payment.refundIssued,
    methodOfPayment: payment.methodOfPayment || "—",
    paymentMethod: payment.paymentMethod || "—",
    referenceNumber: payment.referenceNumber || "—",
    paymongoPaymentID: payment.paymongoPaymentID || null,
    status,
    paymentStage,
    // Cancelled but the customer's money is still held (e.g. auto-cancelled with
    // a paid deposit and no refund opened): staff need to see that.
    heldAfterCancel: bookingStatus === "cancelled" && amountPaid > 0 && String(payment.status || "").toLowerCase() !== "refunded" && !openRefund,
    proofUrl: payment.proofUrl || "",
    depositFee: Number(payment.depositFee) || 0,
    rentalFee: Number(payment.rentalFee) || 0,
    extraFee: Number(payment.extraFee) || 0,
    serviceFee: Number(payment.serviceFee) || 0,

    // ── how it was actually paid (previously stored but never shown) ──
    paymongoChannel: payment.paymongoChannel || null,       // gcash | paymaya | qrph
    depositPaymongoPaymentID: paymongoIDs.deposit,
    balancePaymongoPaymentID: paymongoIDs.balance,
    paidAt: isoOf(payment.paidAt),
    confirmedBy: payment.confirmedBy || null,                // staff who confirmed a cash deposit
    confirmedAt: isoOf(payment.confirmedAt),
    balanceStatus: payment.balanceStatus || null,            // paid = settled online through PayMongo
    balanceAmount: Number(payment.balanceAmount) || 0,
    balanceCollected: !!payment.balanceCollected,            // staff collected it in person
    balanceMethod: payment.balanceMethod || null,            // Cash | GCash | Bank Transfer
    balanceCollectedBy: payment.balanceCollectedBy || null,
    balanceCollectedAt: isoOf(payment.balanceCollectedAt),
    balancePaidAt: isoOf(payment.balancePaidAt),

    // ── refund in flight (if any) ──
    refundRequestID: openRefund ? openRefund.id : null,
    refundRequestStatus: openRefund ? openRefund.status : null,

    createdAt: isoOf(payment.createdAt),
    updatedAt: isoOf(payment.updatedAt),
  };
};

// Moves a booking from "to pay" to "upcoming" (and mirrors it onto its
// bookingSession). No-op for any other status. Returns true if it promoted.
const promoteBookingIfToPay = async (bookingID) => {
  try {
    let bookingRef = db.collection("bookings").doc(bookingID);
    let bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) {
      const q = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
      if (q.empty) return false;
      bookingRef = q.docs[0].ref; bookingSnap = q.docs[0];
    }
    if (bookingSnap.data().status !== "to pay") return false;
    await bookingRef.update({ status: "upcoming", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    const sessionSnap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
    if (!sessionSnap.empty && sessionSnap.docs[0].data().status === "to pay") {
      await sessionSnap.docs[0].ref.update({ status: "upcoming", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    return true;
  } catch (err) {
    console.error("promoteBookingIfToPay failed:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// Confirm a booking's initial payment as received — for Cash/in-person
// payments where staff or the driver physically receive the initial
// portion (Full/Downpayment/Deposit) directly at the counter or at
// pickup, rather than it coming through PayMongo (GCash/Maya/QRPH),
// which is already auto-confirmed by handleWebhook() on the customer
// side the moment it settles — no manual step needed there at all.
//
// This lets Car Tracking / My Trips confirm cash on the spot instead of
// requiring a trip to the Payments page just to click Approve.
// ─────────────────────────────────────────────
export const confirmInitialPayment = async (bookingID, confirmedBy, paymentMethod) => {
  if (!bookingID) throw new Error("bookingID is required.");
  assertValidPaymentMethod(paymentMethod);

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const status = (data.status || "").toLowerCase();
  if (status === "approved" || status === "paid") {
    throw new Error("This payment is already confirmed.");
  }
  if (status === "rejected" || status === "cancelled" || status === "refunded") {
    throw new Error(`Cannot confirm: payment is ${data.status}.`);
  }

  // What staff actually received now — the deposit portion, NOT the grand total.
  // (It used to log data.amount, so a Partial booking put ₱5,000 in the ledger
  // for ₱2,500 received, and the later balance entry then counted the rest again.)
  const depositReceived = getPaymentBreakdown({ ...data, status: "paid" }).depositCollected;

  await doc.ref.update({
    status:        "Approved",
    // This is the first point the actual mode is ever captured for a
    // cash/in-person initial payment — previously this field just held
    // whatever default ("Cash") was set at booking creation, whether or
    // not that was actually how the customer paid. Overwriting it here is
    // safe (unlike the balance case below) since this IS the payment the
    // method describes, not a second one layered on top of an earlier one.
    paymentMethod,
    confirmedBy:   confirmedBy || "—",
    confirmedAt:   admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
  });

  createTransactionLog({
    bookingID,
    paymentID: data.paymentID || doc.id,
    userID: data.userID || null,
    type: "Payment",
    amount: depositReceived,
    status: "Success",
    paymentMethod,
    referenceNumber: data.referenceNumber || "—",
    description: `Cash payment of ₱${depositReceived.toLocaleString()} confirmed by staff for booking ${bookingID} via ${paymentMethod}.`,
    performedBy: confirmedBy || "—",
    logID: `${data.paymentID || doc.id}_deposit`, // same key the customer app uses → never logged twice
  });

  // Bookings now start at "to pay". A staff-confirmed cash deposit is the other
  // way (besides PayMongo) that a booking becomes real, so promote it here too —
  // otherwise it would sit at "to pay" and be auto-cancelled with the money in hand.
  const promoted = await promoteBookingIfToPay(bookingID);

  auditSafe({
    action: "update",
    description: `Payment for booking ${bookingID} confirmed by staff as received (₱${depositReceived.toLocaleString()} via ${paymentMethod})${promoted ? "; booking moved from to pay to upcoming" : ""}.`,
    userID: confirmedBy || null,
    bookingID,
    paymentID: data.paymentID || doc.id,
  });

  return { id: doc.id, bookingID };
};

// ─────────────────────────────────────────────
// Manually mark a booking's remaining balance as collected — for
// Cash/in-person payments where staff or the driver physically receive
// the rest of the fee at pickup or return, rather than it coming through
// an online GCash/Maya proof that gets Approved on the Payments page.
//
// Requires the payment's initial portion to already be Approved/Paid
// first (this mirrors the same gate updateBooking() already applies
// before a booking can move to "ongoing" — by the time anyone is at
// pickup, the payment record is guaranteed to already be Approved).
// ─────────────────────────────────────────────
export const collectRemainingBalance = async (bookingID, collectedBy, paymentMethod) => {
  if (!bookingID) throw new Error("bookingID is required.");
  assertValidPaymentMethod(paymentMethod);

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const status = (data.status || "").toLowerCase();
  if (status !== "approved" && status !== "paid") {
    throw new Error(
      `Cannot collect balance: payment is still "${data.status || "Pending"}". ` +
      `Approve the payment first in the Payments page.`
    );
  }
  if (data.balanceCollected) {
    throw new Error("This booking is already marked fully paid.");
  }
  // The customer can also pay the balance online (Pay Balance). If they did,
  // collecting it again in cash would take the same money twice.
  if (String(data.balanceStatus || "").toLowerCase() === "paid") {
    throw new Error("The customer already paid the balance online — there is nothing left to collect.");
  }
  // Don't take more money on a payment that's mid-refund.
  const openRefund = await findOpenRefundRequest(data.paymentID || doc.id);
  if (openRefund) {
    throw new Error(`A refund request (${openRefund.status}) is open for this booking — resolve it before collecting the balance.`);
  }

  const { balance } = computeAmounts(data);
  if (balance <= 0) {
    throw new Error("There is no remaining balance to collect.");
  }

  await doc.ref.update({
    balanceCollected:   true,
    // How it was paid + how much — previously only in the transaction log, so the
    // Payments page couldn't show it and a later refund couldn't know which part
    // was cash that PayMongo can't return.
    balanceMethod:          paymentMethod,
    balanceCollectedAmount: balance,
    balanceCollectedAt: admin.firestore.FieldValue.serverTimestamp(),
    balanceCollectedBy: collectedBy || "—",
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  });

  createTransactionLog({
    bookingID,
    paymentID: data.paymentID || doc.id,
    userID: data.userID || null,
    type: "Payment",
    amount: balance,
    status: "Success",
    // Now actually asked at the moment of collection instead of reused
    // from data.paymentMethod (the ORIGINAL deposit's method) or hardcoded
    // as "Not recorded" — both of those were wrong for mixed-method cases
    // (e.g. a GCash deposit followed by a cash balance). This is scoped to
    // the transaction log entry only; the payment doc's own paymentMethod
    // field is deliberately left alone here since it still describes the
    // original deposit, not this separate balance collection.
    paymentMethod,
    referenceNumber: data.referenceNumber || "—",
    description: `Remaining balance of ₱${balance.toLocaleString()} collected in person for booking ${bookingID} via ${paymentMethod}.`,
    performedBy: collectedBy || "—",
    logID: `${data.paymentID || doc.id}_balance`,
  });

  auditSafe({
    action: "update",
    description: `Remaining balance of ₱${balance.toLocaleString()} collected in person via ${paymentMethod} for booking ${bookingID}.`,
    userID: collectedBy || null,
    bookingID,
    paymentID: data.paymentID || doc.id,
  });

  return { id: doc.id, bookingID };
};

// ─────────────────────────────────────────────
// Staff applying a flat-peso discount to a booking's payment — e.g. a
// goodwill deduction at pickup. Flat peso only, deliberately no
// percentage option (matches how discounts are actually decided in
// person). Staff-only to CALL (Payments.jsx or Car Tracking) — there's
// still no driver-facing route to apply one. But the driver IS one of the
// people notified once it's applied (see notifyPerson(driverID, ...)
// below), and on a chauffeur booking this blocks entirely until a driver
// is assigned, since there'd otherwise be nobody in that role to notify.
// ─────────────────────────────────────────────
export const applyDiscount = async (bookingID, amount, reason, appliedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const discountAmount = Number(amount);
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    throw new Error("Discount must be a valid, non-negative peso amount.");
  }

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc = snap.docs[0];
  const existing = doc.data();

  // Can't discount more than the booking is actually worth — previously
  // unbounded, so a discount larger than the total fee would spill past
  // everything the customer ever paid and create a refundDue for money
  // that was never collected in the first place.
  const totalFee = Number(existing.amount) || 0;
  if (discountAmount > totalFee) {
    throw new Error(`Discount can't exceed the total fee of ₱${totalFee.toLocaleString()}.`);
  }

  // Need the booking doc for three things below: the chauffeur/driver
  // gate, the driver notification, and as a fallback source for the
  // customer's userID (see resolveCustomerUserID).
  const booking = await findBookingByBookingID(bookingID);
  const isChauffeur = booking?.modeOfDriving === "With Chauffeur";
  const driverID = booking?.driverID || null;

  // A chauffeur trip needs a driver on record before a discount can be
  // applied — the driver is one of the people who gets notified about the
  // discount below, and there's nobody to notify if none is assigned yet.
  // Self-drive bookings never have a driver, so this only applies here.
  if (isChauffeur && !driverID) {
    throw new Error(
      "This is a chauffeur booking with no driver assigned yet. " +
      "Assign a driver first — they need to be notified when a discount is applied."
    );
  }

  // Once a refund created by this discount has already been physically
  // handed back (refundIssued: true), this route is no longer the right
  // one — reopening/renotifying over a discount that's already been
  // settled in person would be misleading (see correctIssuedDiscount()
  // below, which is the Admin-only path for fixing the number on record
  // after the fact, without reopening or re-notifying anyone).
  if (existing.refundIssued) {
    throw new Error(
      "This discount's refund has already been marked as returned. " +
      "Only an Admin can correct the recorded amount now, via the discount correction option."
    );
  }

  // Payment is already fully refunded — closed out, nothing left to
  // discount against. Writing a discount here wouldn't change any money
  // (the math short-circuits to zero) but it would sit on the record
  // looking like an active discount on a payment that's already settled.
  if (String(existing.status || "").toLowerCase() === "refunded") {
    throw new Error("This payment has already been refunded — a discount can't be applied to it.");
  }

  // A refund request is open (Pending review or Approved but not yet
  // physically returned). Changing the discount now would silently shift
  // the numbers computeRefundPlan is using mid-flight, or disagree with
  // an amount that's already gone out via PayMongo/cash.
  const openRefundRequest = await findOpenRefundRequest(existing.paymentID || doc.id);
  if (openRefundRequest) {
    throw new Error(
      "A refund request is already open for this payment. " +
      "Resolve or cancel that refund request before applying a new discount."
    );
  }

  // Figure out if this new discount amount spills past the outstanding
  // balance — i.e. creates a refund owed to the customer. Reset
  // refundIssued to false here: this is a fresh discount value, so any
  // earlier "returned" mark doesn't necessarily still apply to it.
  const { refundDue } = computeAmounts({ ...existing, discountAmount, refundIssued: false });

  await doc.ref.update({
    discountAmount,
    discountReason: reason || "",
    discountBy:     appliedBy || "—",
    discountAt:     admin.firestore.FieldValue.serverTimestamp(),
    refundDue,
    refundIssued:   false,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  // Lightweight bell ping to Owner/Admin/Supervisor for EVERY discount —
  // separate from the refund_due alert below, which is specifically about
  // money owed back and stays as its own actionable notification. This one
  // is just "a discount happened," so staff aren't blind to discounts that
  // never create a refund.
  await notifyStaff({
    type: "discount_applied",
    refID: bookingID,
    refCollection: "bookings",
    title: "Discount Applied",
    message: `A discount of ₱${discountAmount.toLocaleString()} was applied to booking ${bookingID}${reason ? ` (${reason})` : ""}.`,
  });

  if (refundDue > 0) {
    // Fanned out to Owner/Admin/Supervisor only — no longer a global
    // userID:null doc.
    await notifyStaff({
      type: "refund_due",
      refID: bookingID,
      refCollection: "bookings",
      title: "Refund due to customer",
      message: `A discount was applied to booking ${bookingID} after it was already paid — ₱${refundDue.toLocaleString()} needs to be returned to the customer.`,
    });
  } else {
    // Discount was reduced/removed so it no longer creates a refund —
    // clear out any stale active alert for this booking.
    await resolveNotification("refund_due", bookingID);
  }

  // Customer-facing bell — separate from the staff alert above. A discount
  // is good news for the customer either way, so this fires regardless of
  // whether it also created a refund; the wording just adds the refund
  // line when there is one, without exposing the internal discountReason.
  const customerUserID = resolveCustomerUserID(existing.userID, booking);
  await notifyCustomer(
    customerUserID, bookingID, "discount_applied", "Discount Applied",
    refundDue > 0
      ? `A discount of ₱${discountAmount.toLocaleString()} was applied to your booking ${bookingID}. Since you already paid, ₱${refundDue.toLocaleString()} will be returned to you.`
      : `A discount of ₱${discountAmount.toLocaleString()} was applied to your booking ${bookingID}.`
  );

  // Driver ping — only chauffeur trips have one, and the gate above
  // guarantees driverID is set whenever isChauffeur is true, so this
  // fires every time it's relevant.
  if (driverID) {
    await notifyPerson(
      driverID, bookingID, "discount_applied", "Discount Applied To Your Trip",
      `A discount of ₱${discountAmount.toLocaleString()} was applied to booking ${bookingID}.`
    );
  }

  createTransactionLog({
    bookingID,
    paymentID: existing.paymentID || doc.id,
    userID: customerUserID,
    type: "Discount",
    amount: discountAmount,
    status: "Success",
    description: reason
      ? `Discount of ₱${discountAmount.toLocaleString()} applied to booking ${bookingID}: ${reason}`
      : `Discount of ₱${discountAmount.toLocaleString()} applied to booking ${bookingID}.`,
    performedBy: appliedBy || "—",
  });

  auditSafe({
    action: "update",
    description: `Discount of ₱${discountAmount.toLocaleString()} applied to booking ${bookingID}${reason ? ` (${reason})` : ""}${refundDue > 0 ? `; ₱${refundDue.toLocaleString()} now owed back to the customer` : ""}.`,
    userID: appliedBy || null,
    bookingID,
    paymentID: existing.paymentID || doc.id,
  });

  return { id: doc.id, bookingID, discountAmount, refundDue };
};

// ─────────────────────────────────────────────
// Admin-only "backdoor" correction — for when a discount's refund has
// ALREADY been marked as returned (refundIssued: true) via
// markRefundIssued(), but the recorded amount was wrong (e.g. staff
// verbally told the driver ₱500 but only entered ₱50 in the system, the
// driver handed over ₱500 and clicked "given" against the ₱50 figure).
//
// This exists purely to fix the paper trail after the fact — it does NOT
// reopen the refund (refundIssued stays true) and does NOT create or
// touch the refund_due notification, since nothing further is being
// asked of the driver or anyone else; the money already changed hands.
// Route-gated to Admin only (see payments.routes.js) — Owner and
// Supervisor go through the normal applyDiscount() edit flow instead,
// which is blocked once refundIssued is true (see above).
// ─────────────────────────────────────────────
export const correctIssuedDiscount = async (bookingID, amount, reason, correctedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const discountAmount = Number(amount);
  if (!Number.isFinite(discountAmount) || discountAmount < 0) {
    throw new Error("Discount must be a valid, non-negative peso amount.");
  }
  if (!reason || !reason.trim()) {
    throw new Error("A reason is required when correcting an already-issued discount.");
  }

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc = snap.docs[0];
  const existing = doc.data();

  if (!existing.refundIssued) {
    throw new Error(
      "This booking's refund hasn't been marked as returned yet — use the normal discount edit instead."
    );
  }

  // Same cap as applyDiscount — a correction still can't record a discount
  // bigger than the booking was ever worth.
  const totalFee = Number(existing.amount) || 0;
  if (discountAmount > totalFee) {
    throw new Error(`Discount can't exceed the total fee of ₱${totalFee.toLocaleString()}.`);
  }

  const previousAmount = Number(existing.discountAmount) || 0;

  // Recompute refundDue against the corrected number, but leave
  // refundIssued exactly as it was (true) — this is a records-only fix,
  // not a new refund event.
  const { refundDue } = computeAmounts({ ...existing, discountAmount, refundIssued: true });

  await doc.ref.update({
    discountAmount,
    discountReason: reason.trim(),
    refundDue,
    discountCorrectedBy: correctedBy || "—",
    discountCorrectedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:           admin.firestore.FieldValue.serverTimestamp(),
  });

  // Deliberately no createNotification()/resolveNotification() call here
  // — see comment above.

  return { id: doc.id, bookingID, previousAmount, discountAmount, refundDue };
};

// ─────────────────────────────────────────────
// Staff OR the driver holding the cash confirming a refund-due amount
// (see applyDiscount()'s refundDue above) was actually handed back to
// the customer. Resolves the refund_due notification once marked.
// ─────────────────────────────────────────────
export const markRefundIssued = async (bookingID, issuedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = doc.data();

  const { refundDue } = computeAmounts(data);
  if (refundDue <= 0) {
    throw new Error("There is no refund due on this booking.");
  }

  await doc.ref.update({
    refundIssued:   true,
    refundIssuedBy: issuedBy || "—",
    refundIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });

  await resolveNotification("refund_due", bookingID);

  const booking = await findBookingByBookingID(bookingID);
  const customerUserID = resolveCustomerUserID(data.userID, booking);
  await notifyCustomer(
    customerUserID, bookingID, "refund_completed", "Refund Completed",
    `Your refund of ₱${refundDue.toLocaleString()} for booking ${bookingID} has been returned.`
  );

  createTransactionLog({
    bookingID,
    paymentID: data.paymentID || doc.id,
    userID: customerUserID,
    type: "Refund",
    amount: refundDue,
    status: "Refunded",
    description: `Discount-spillover refund of ₱${refundDue.toLocaleString()} handed back to customer for booking ${bookingID}.`,
    performedBy: issuedBy || "—",
  });

  auditSafe({
    action: "update",
    description: `Discount-spillover refund of ₱${refundDue.toLocaleString()} marked as handed back to the customer for booking ${bookingID}.`,
    userID: issuedBy || null,
    bookingID,
    paymentID: data.paymentID || doc.id,
  });

  return { id: doc.id, bookingID };
};

export const getAllPayments = async () => {
  const snapshot = await db.collection("payments").orderBy("createdAt", "desc").get();
  const docs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Batch-resolve bookings for carID and userID
  const bookingIDs = [...new Set(docs.map((d) => d.bookingID).filter(Boolean))];
  const bookingMap = {};
  if (bookingIDs.length) {
    const bookingDocs = await Promise.all(
      bookingIDs.map((id) => db.collection("bookings").doc(id).get())
    );
    bookingDocs.forEach((doc) => {
      if (doc.exists) bookingMap[doc.id] = doc.data();
    });
  }

  // Collect unique carIDs and userIDs from bookings
  const carIDs  = [...new Set(Object.values(bookingMap).map((b) => b.carID).filter(Boolean))];
  const userIDs = [...new Set(Object.values(bookingMap).map((b) => b.userID).filter(Boolean))];

  // Resolve vehicles
  const vehicleMap = {};
  await Promise.all(carIDs.map(async (id) => {
    vehicleMap[id] = await resolveVehicleName(id);
  }));

  // Resolve customer names
  const nameMap = {};
  await Promise.all(userIDs.map(async (id) => {
    nameMap[id] = await resolveCustomerName(id);
  }));

  // One query for every refund currently in flight → a Set-like map keyed by paymentID.
  const openRefundSnap = await db.collection("refundRequests").where("status", "in", OPEN_REFUND_STATUSES).get();
  const openRefundByPayment = {};
  openRefundSnap.docs.forEach((d) => { openRefundByPayment[d.data().paymentID] = { id: d.id, ...d.data() }; });

  return docs.map((payment) => {
    const booking = bookingMap[payment.bookingID] || {};
    const vehicleName = vehicleMap[booking.carID] || "—";
    const customerName = nameMap[booking.userID] || "—";
    return buildPaymentRow(payment, booking, customerName, vehicleName, openRefundByPayment[payment.paymentID || payment.id] || null);
  });
};

export const updatePaymentStatus = async (id, status, performedBy = null) => {
  const allowed = ["Pending", "Approved", "Rejected", "Cancelled"];
  if (!allowed.includes(status)) throw new Error("Invalid status.");

  const ref  = db.collection("payments").doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Payment not found.");
  const existing = snap.data();

  // A refunded payment is final — approving/rejecting it would overwrite the
  // "Refunded" status the PayMongo webhook set and lose the refund record.
  if (String(existing.status || "").toLowerCase() === "refunded") {
    throw new Error("This payment has already been refunded, so its status can't be changed.");
  }

  await ref.update({
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Manually approving a payment means staff have the money. Bookings now start at
  // "to pay", so without this the booking would stay there and be auto-cancelled
  // by the customer app's 12-hour sweep even though staff had approved the payment.
  const promoted = status === "Approved" ? await promoteBookingIfToPay(existing.bookingID) : false;

  auditSafe({
    action: "update",
    description: `Payment ${existing.paymentID || id} manually set from "${existing.status || "—"}" to "${status}"${promoted ? "; booking moved from to pay to upcoming" : ""}.`,
    userID: performedBy,
    bookingID: existing.bookingID || null,
    paymentID: existing.paymentID || id,
  });
};

export const getPaymentById = async (id) => {
  const doc = await db.collection("payments").doc(id).get();
  if (!doc.exists) throw new Error("Payment not found.");
  const payment = { id: doc.id, ...doc.data() };

  const booking = payment.bookingID
    ? (await db.collection("bookings").doc(payment.bookingID).get())
    : null;
  const bookingData = booking?.exists ? booking.data() : {};

  const [customerName, vehicleName] = await Promise.all([
    resolveCustomerName(bookingData.userID),
    resolveVehicleName(bookingData.carID),
  ]);

  const openRefund = await findOpenRefundRequest(payment.paymentID || payment.id);
  return buildPaymentRow(payment, bookingData, customerName, vehicleName, openRefund);
};