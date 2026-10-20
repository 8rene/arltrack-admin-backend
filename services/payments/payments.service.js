import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { notifyStaff, resolveNotification, createNotification } from "../notification/notification.service.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";
import { getPaymentBreakdown, resolvePaymongoIDs, payTypeOf, depositWasOnline } from "./paymentBreakdown.js";
import { createPaymongoRefund, resolveCustomerContact } from "../refundRequest/refundRequest.service.js";
import { sendBalanceReminderEmail } from "../email/email.service.js";
import { syncPaymentEntries, hydratePayments, hydratePaymentData, getEntriesForPaymentIDs, ENTRY_COLLECTION } from "../paymentEntries/paymentEntries.service.js";
import { resolveUserNames } from "../archives/resolveUserName.service.js";
import { getDepositView } from "./paymentHelpers.js";
import {
  getDiscountFigures, getDiscountView, hasLegacyDiscount, discountRoom, planNewDiscount, applyNewDiscount, DISCOUNT_PHASES,
} from "./discountLedger.js";

// Customer-facing bell notification — mirrors the helper of the same name
// in refundRequest.service.js. No-ops quietly if there's no userID on the
// payment record (shouldn't happen, but this is a side-effect, not the
// main flow, so it shouldn't be able to fail the discount itself).
const notifyCustomer = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[PAYMENTS] failed to notify customer (${type}):`, err.message));
};

// Looks up a booking by its bookingID (not the Firestore doc id) — used by
// applyDiscount() as the fallback source for the customer's userID
// (see resolveCustomerUserID).
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

// An in-store payment is only a proper record if it says HOW it was paid and, for anything that isn't
// cash, carries the transfer's reference number. Cash may carry an official-receipt number (optional).
// Returns the cleaned reference (or null).
const REFERENCE_MAX = 64;
const cleanReference = (method, referenceNumber) => {
  const ref = String(referenceNumber == null ? "" : referenceNumber).trim();
  if (method !== "Cash" && !ref) {
    throw new Error(`A reference number is required for ${method} payments.`);
  }
  if (ref.length > REFERENCE_MAX) {
    throw new Error(`The reference number can't be longer than ${REFERENCE_MAX} characters.`);
  }
  return ref || null;
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
// Exported for staffRefundBooking() (services/refundRequest/refundRequest.
// service.js) too — it needs the exact same check before firing a refund of
// its own, so a customer's own already-submitted (Pending/Approved) refund
// request on the same payment can never get raced/duplicated by the staff
// status-change batch.
export const findOpenRefundRequest = async (paymentID) => {
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

// One list of every charge on a payment: the deposit/only payment and (Partial)
// the balance — paid online, paid in person, still pending, failed or not yet due.
// Built from the existing fields today; the shape is deliberately the same as a
// stored `paymongoTransactions` array so that switching to one later only changes
// this function, not the UI.
//   { phase, ref, amount, fee, channel, source: "online"|"in_person", status, paidAt, by }
const buildTransactions = (payment) => {
  const p = payment || {};
  const low = (v) => String(v || "").toLowerCase();
  const ids = resolvePaymongoIDs(p);
  const amount = Number(p.amount) || 0;
  const payType = payTypeOf(p);

  // What each phase is worth, whether or not it has been paid yet.
  const expectedDeposit = getPaymentBreakdown({ ...p, status: "paid", balanceStatus: "", balanceCollected: false, discountAmount: 0 }).depositCollected;
  const expectedBalance = Math.max(0, amount - expectedDeposit);

  const statusOf = (raw) => {
    const s = low(raw);
    if (s === "paid" || s === "approved") return "Paid";
    if (s === "refunded") return "Refunded";
    if (s === "failed" || s === "rejected") return "Failed";
    if (s === "cancelled" || s === "canceled") return "Cancelled";
    return "Pending";
  };

  const list = [];

  // ── Deposit (or the single payment for Full) ──
  const depositOnline = !!(ids.deposit || p.paymongoChannel || !["paid", "approved"].includes(low(p.status)));
  list.push({
    phase: "deposit",
    ref: ids.deposit || null,
    amount: expectedDeposit,
    fee: p.depositPaymongoFee ?? null,
    channel: depositOnline ? (p.paymongoChannel || null) : (p.paymentMethod && p.paymentMethod !== "—" ? p.paymentMethod : null),
    source: depositOnline ? "online" : "in_person",
    status: statusOf(p.status),
    paidAt: isoOf(p.paidAt) || isoOf(p.confirmedAt),
    by: depositOnline ? null : (p.confirmedBy || null),
  });

  // ── Balance (Partial / Downpayment only) ──
  if (payType !== "Full" && expectedBalance > 0) {
    if (p.balanceCollected) {
      const rec = Number(p.balanceCollectedAmount);
      list.push({
        phase: "balance",
        ref: p.balanceReferenceNumber || null,
        amount: Number.isFinite(rec) && p.balanceCollectedAmount !== null && p.balanceCollectedAmount !== undefined ? rec : expectedBalance,
        fee: null,
        channel: p.balanceMethod || null,
        source: "in_person",
        status: "Paid",
        paidAt: isoOf(p.balanceCollectedAt),
        by: p.balanceCollectedBy || null,
      });
    } else {
      const bs = low(p.balanceStatus);
      list.push({
        phase: "balance",
        ref: ids.balance || null,
        amount: Number(p.balanceAmount) || expectedBalance,
        fee: p.balancePaymongoFee ?? null,
        channel: ids.balance || bs === "pending" ? (p.paymongoChannel || null) : null,
        source: "online",
        status: bs === "paid" ? "Paid"
              : bs === "pending" ? "Pending"
              : bs === "failed" ? "Failed"
              : bs === "cancelled" ? "Cancelled"
              : "Not yet due",
        paidAt: isoOf(p.balancePaidAt),
        by: null,
      });
    }
  }
  return list;
};

// ─────────────────────────────────────────────
// Where a discount's money stands. A discount is ONE thing for staff, but the money behind it moves in one of
// three ways, and PayMongo takes time (up to ~24h) for the online one, so "refundIssued" alone is not enough:
//
//   null            no discount on this payment
//   deducted        it came off the remaining balance; no money moved
//   processing      PayMongo accepted the refund and has not confirmed it yet      (out-row "pending")
//   refunded        PayMongo confirmed it (or staff handed it back in store)       (out-row "success")
//   failed          PayMongo refused it after accepting it -- the customer is still owed the money  (out-row "failed")
//   awaiting_handback  money was received in store, so staff must hand it back in store
//   held            (ledger discounts only) the customer already paid it; it is held and returns with the deposit
//   returned        (ledger discounts only) the held credit went back with the deposit
//
// Read from the payment's "out" rows (phase "discount"); the newest row wins, so a retry supersedes a failed one.
// ─────────────────────────────────────────────
export const deriveDiscountRefund = (payment, entries = []) => {
  const discountAmount = Number(payment && payment.discountAmount) || 0;
  if (!(discountAmount > 0)) return null;

  // A LEDGER discount (see discountLedger.js) never refunds on the spot. Where its money stands:
  //   deducted   it came off the balance / paid penalties: nothing is owed back
  //   held       credit is held and goes back with the security deposit at settlement
  //   processing | failed | returned   its own payout (the discount_return row): PayMongo working on it, refused it, or done
  // `view` is the full picture for the screen (figures, history, whether the stored numbers still match the rows).
  if (getDiscountFigures(payment).ledger) {
    const view = getDiscountView(payment, entries);
    const cr = view.creditReturn;
    const base = { amount: 0, via: null, referenceNumber: null, errorNote: null, at: null, view };
    if (cr) return { ...base, state: cr.state, amount: cr.amount, via: cr.via, referenceNumber: cr.referenceNumber, errorNote: cr.errorNote, at: cr.at };
    if (view.credit > 0) return { ...base, state: "held", amount: view.credit };
    return { ...base, state: "deducted" };
  }

  const rows = (entries || [])
    .filter((e) => e && e.direction === "out" && e.phase === "discount")
    .sort((a, b) => {
      const t = (x) => { const d = x.createdAt; const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null; return v && !isNaN(v) ? v.getTime() : 0; };
      return t(b) - t(a);
    });
  const latest = rows[0] || null;
  const { refundDue } = computeAmounts({ ...payment, discountAmount, refundIssued: false });   // spillover only; 0 = fit in the balance
  const base = { amount: refundDue, via: null, referenceNumber: null, errorNote: null, at: null, view: getDiscountView(payment, entries) };
  if (latest) {
    const st = String(latest.status || "").toLowerCase();
    const at = latest.settledAt || latest.processedAt || latest.createdAt || null;
    const common = { amount: Number(latest.amount) || refundDue, via: latest.source === "online" ? "paymongo" : "in_store", referenceNumber: latest.referenceNumber || null, errorNote: latest.transactionErrorNote || null, at };
    if (st === "success") return { ...base, ...common, state: "refunded" };
    if (st === "failed")  return { ...base, ...common, state: "failed" };
    return { ...base, ...common, state: "processing" };
  }
  if (refundDue <= 0) return { ...base, state: "deducted" };
  return { ...base, state: payment.refundIssued ? "refunded" : "awaiting_handback", via: "in_store" };
};

// Same thing, looked up from the database.
export const getDiscountRefundState = async (payment, docID) => {
  if (!(Number(payment && payment.discountAmount) > 0)) return null;
  const key = payment.paymentID || docID;
  const rows = (await getEntriesForPaymentIDs([key])).get(key) || [];
  return deriveDiscountRefund(payment, rows);
};

// One place that shapes a payment for the admin UI (used by list + detail).
const buildPaymentRow = (payment, booking, customerName, vehicleName, openRefund, discountRefund = null) => {
  const { amountPaid, balance, payType, refundDue } = computeAmounts(payment);
  const bookingStatus = (booking.status || "").toLowerCase();

  // Raw-status field the older screens still compare against. A cancelled
  // booking shows "Cancelled" — EXCEPT a payment that was actually refunded,
  // which must stay "Refunded" (it used to be overwritten by "Cancelled",
  // hiding the fact that the money had been returned).
  let status = normalizePaymentStatus(payment.status);
  if (bookingStatus === "cancelled" && status !== "Refunded") status = "Cancelled";

  const paymongoIDs = resolvePaymongoIDs(payment);
  const dep = getDepositView(payment);   // understands both the flat and the old nested deposit shape
  const paymentStage = derivePaymentStage(payment, { bookingStatus, hasOpenRefund: !!openRefund });

  return {
    id: payment.id,
    paymentID: payment.paymentID || payment.id,
    bookingID: payment.bookingID || "—",
    bookingStatus: booking.status || null,   // lets the Payments screen offer "Return deposit" only while the booking is ongoing
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
    // Where the discount's money stands (see deriveDiscountRefund):
    //   null | deducted | held | processing | returned | refunded | failed | awaiting_handback
    discountRefund,
    // The discount in full (figures, history, status) -- see discountLedger.getDiscountView. null = no discount.
    discount: (discountRefund && discountRefund.view) || getDiscountView(payment),
    // How much MORE discount could be given right now, where it would go, and why not (null = it can be given).
    ...(() => {
      const room = discountRoom({
        totalFee: Number(payment.amount) || 0,
        grossPaid: computeAmounts({ ...payment, discountAmount: 0 }).amountPaid,
        balance,
        given: getDiscountFigures(payment).total,
        depositStatus: dep ? dep.status : null,
        legacy: hasLegacyDiscount(payment),
      });
      return { discountMax: room.max, discountKind: room.kind, discountBlocked: room.blocked };
    })(),
    methodOfPayment: payment.methodOfPayment || "—",
    paymentMethod: payment.paymentMethod || "—",
    paymongoPaymentID: payment.paymongoPaymentID || null,
    status,
    paymentStage,
    // Cancelled but the customer's money is still held (e.g. auto-cancelled with
    // a paid deposit and no refund opened): staff need to see that.
    heldAfterCancel: bookingStatus === "cancelled" && amountPaid > 0 && String(payment.status || "").toLowerCase() !== "refunded" && !openRefund,
    rentalFee: Number(payment.rentalFee) || 0,
    extraFee: Number(payment.extraFee) || 0,
    driversFee: Number(payment.driversFee) || 0,
    serviceFee: Number(payment.serviceFee) || 0,
    gatewayFee: Number(payment.gatewayFee) || 0,
    securityDeposit: Number(payment.securityDeposit) || 0,
    depositStatus: dep ? dep.status : null,                 // Held | Waived | Settled | Forfeited | Refunded
    depositSettled: dep ? Number(dep.deducted) || 0 : 0,    // pesos of the deposit used to pay penalties
    depositReturned: dep ? Number(dep.returnedAmount) || 0 : 0, // pesos of the deposit handed back to the customer
    // % rates + the base the gateway fee was computed on (saved at booking time)
    serviceFeeRate: Number(payment.serviceFeeRate) || 0,
    gatewayFeeRate: Number(payment.gatewayFeeRate) || 0,
    gatewayFeeBase: Number(payment.gatewayFeeBase) || 0,

    // PayMongo's OWN transaction fee for this booking's online charge(s), as reported
    // by PayMongo (not the gateway fee charged to the customer): one entry per online
    // charge plus the running total across both. null = not recorded (cash payment, or
    // paid before fee tracking started; see customer-backend/scripts/backfillPaymongoFees.js).
    paymongoFee: {
      deposit: payment.depositPaymongoFee ?? null,
      balance: payment.balancePaymongoFee ?? null,
      total:   payment.paymongoFeeTotal ?? null,
    },

    // Penalties paid online ({ paymongoFee, paid, count } from the entries), or null when none was. getPaymentById() completes
    // it with `received` (the online payment fee the customer paid, kept on the penalties). Kept apart from
    // gatewayFee / paymongoFee above, which are deposit + balance only.
    penaltyGateway: payment.penaltyGateway ?? null,

    // Every charge on this payment as one list (deposit + balance, incl. pending ones).
    paymongoTransactions: buildTransactions(payment),

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
    balanceReferenceNumber: payment.balanceReferenceNumber || null,   // in-store payment: transfer / receipt number
    balanceReminderAt: isoOf(payment.balanceReminderAt),               // last "please pay the balance" nudge
    balancePaidAt: isoOf(payment.balancePaidAt),
    discountBy: payment.discountBy || null,
    discountAt: isoOf(payment.discountAt),

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

// Records a staff action in paymentEntries. WHO took the money, WHEN, HOW and HOW MUCH (confirmedBy / confirmedAt,
// balanceCollected / balanceCollectedAmount / balanceMethod / balanceCollectedBy / balanceCollectedAt) are written to
// the entry row only -- never onto the payment document, which keeps just the status and amounts. The sync is idempotent, so a failure is retried
// once and then reported: the status change is already saved, and pressing the same action again (or the
// next sync) writes the row. Nothing is ever put back on the document in the old shape.
const recordInEntries = async (docRef, docID, fields) => {
  let r;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    r = await syncPaymentEntries(docID, { fields });
    if (!r.error && r.written) return;
  }
  const why = r.error || "nothing derived";
  console.error(`[PAYMENTS] entry for ${docID} not written (${why}); ${Object.keys(fields).join(", ")} NOT saved.`);
  throw new Error(`The payment was updated, but its payment entry could not be written (${why}). Please try again.`);
};

// Does this payment already have a settled "in" row for the phase? (used to tell "already done" from "done, but
// its row failed to write" -- the latter must be repairable by pressing the same action again.)
const hasSuccessRow = async (data, docID, phase) => {
  const key = data.paymentID || docID;
  const rows = (await getEntriesForPaymentIDs([key])).get(key) || [];
  return rows.some((e) => e.direction !== "out" && e.phase === phase && e.status === "success");
};

// confirmedBy / balanceCollectedBy are stored as the staff member's uid; the Payments page wants a name.
// Older values (an email, or "—") are shown as they are.
const withStaffNames = async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = list.flatMap((r) => [r.confirmedBy, r.balanceCollectedBy])
    .filter((v) => v && v !== "—" && !String(v).includes("@"));
  if (!ids.length) return rows;
  const names = await resolveUserNames(ids);
  const named = list.map((r) => ({
    ...r,
    confirmedBy: names[r.confirmedBy] || r.confirmedBy,
    balanceCollectedBy: names[r.balanceCollectedBy] || r.balanceCollectedBy,
  }));
  return Array.isArray(rows) ? named : named[0];
};

// ─────────────────────────────────────────────
// IN-STORE payment of the remaining balance.
//
// The normal way to pay the balance is online through PayMongo (the customer is
// reminded with notifyBalanceDue below). This is the exception: the customer
// chose to pay at the store. The route only lets Supervisor / Admin / Owner
// call it (drivers no longer collect cash), and it needs a proper record:
// payment mode, the reference number (required for anything but cash), who
// received it and when -- all of which land on the balance paymentEntries row.
//
// Requires the first payment to already be received through PayMongo.
// ─────────────────────────────────────────────
export const collectRemainingBalance = async (bookingID, collectedBy, paymentMethod, referenceNumber = "") => {
  if (!bookingID) throw new Error("bookingID is required.");
  assertValidPaymentMethod(paymentMethod);
  const reference = cleanReference(paymentMethod, referenceNumber);

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
  // "Collected in person" is a settled in-person balance row, not a flag on the payment. Nothing is saved before
  // the row is written, so a failed attempt leaves nothing behind and pressing the action again simply retries.
  const alreadyPaid = await hasSuccessRow(data, doc.id, "balance");
  // Old documents may still carry balanceCollected without a row (an earlier attempt saved the flag, then failed to
  // write the row): pressing the action again writes the row. Disappears once the leftovers script has run.
  const legacyRepair = !alreadyPaid && !!data.balanceCollected;
  if (alreadyPaid) {
    if (String(data.balanceStatus || "").toLowerCase() === "paid") {
      throw new Error("The customer already paid the balance online — there is nothing left to collect.");
    }
    throw new Error("This booking is already marked fully paid.");
  }
  let balance;
  if (legacyRepair) {
    balance = Number(data.balanceCollectedAmount) || 0;
  } else {
    // The customer can also pay the balance online (Pay Balance). If they did,
    // collecting it again in cash would take the same money twice.
    if (String(data.balanceStatus || "").toLowerCase() === "paid") {
      throw new Error("The customer already paid the balance online — there is nothing left to collect.");
    }
    // The customer is paying the balance online right now: taking it in store as well would charge them twice.
    if (String(data.balanceStatus || "").toLowerCase() === "pending") {
      throw new Error("The customer has a balance payment in progress on PayMongo. Wait for it to finish (or fail) before recording an in-store payment.");
    }
    // Don't take more money on a payment that's mid-refund.
    const openRefund = await findOpenRefundRequest(data.paymentID || doc.id);
    if (openRefund) {
      throw new Error(`A refund request (${openRefund.status}) is open for this booking — resolve it before collecting the balance.`);
    }
    ({ balance } = computeAmounts(data));
    if (balance <= 0) {
      throw new Error("There is no remaining balance to collect.");
    }
  }

  // Write the balance row: how it was paid, by whom and when go to the entry, not the payment document.
  // balanceCollected / balanceCollectedAmount are passed as fields too: they are what makes the mapper write this
  // row as an in-person balance of exactly this amount (net of any discount), and they are never stored on the payment.
  await recordInEntries(doc.ref, doc.id, {
    balanceCollected: true,
    balanceCollectedAmount: balance,
    balanceMethod: paymentMethod,
    balanceReferenceNumber: reference,
    balanceCollectedBy: collectedBy || "—",
    balanceCollectedAt: new Date(),
  });
  await doc.ref.update({ updatedAt: admin.firestore.FieldValue.serverTimestamp() });

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
    referenceNumber: reference,
    description: `Remaining balance of ₱${balance.toLocaleString()} received in store for booking ${bookingID} via ${paymentMethod}${reference ? ` (ref ${reference})` : ""}.`,
    performedBy: collectedBy || "—",
    logID: `${data.paymentID || doc.id}_balance`,
    paymentEntryID: `${data.paymentID || doc.id}_balance`, // the balance paymentEntries row this log describes
  });

  auditSafe({
    action: "update",
    description: `Remaining balance of ₱${balance.toLocaleString()} received in store via ${paymentMethod}${reference ? ` (ref ${reference})` : ""} for booking ${bookingID}.`,
    userID: collectedBy || null,
    bookingID,
    paymentID: data.paymentID || doc.id,
  });

  return { id: doc.id, bookingID };
};

// ─────────────────────────────────────────────
// Where does a discount's refund come from?
//
// A discount on a fully paid booking is money going back to the customer. It goes back the same
// way it came in: through PayMongo, against ONE payment that is big enough to cover it (so it is
// either entirely done or entirely refused -- never half refunded). Money that was never on
// PayMongo (a balance received in store) can only be returned in store, which a Supervisor / Admin
// / Owner records with markRefundIssued().
//
//   { paymongo: { paymongoPaymentID, kind } }   refund it through PayMongo
//   { inStore: true }                           hand it back in store, then mark it returned
//   { error }                                   can't be done as one refund
// ─────────────────────────────────────────────
const planDiscountRefund = (payment, amount) => {
  const ids = resolvePaymongoIDs(payment);
  const b = getPaymentBreakdown({ ...payment, discountAmount: 0 });
  const depositOnline = depositWasOnline(payment, ids);

  // Newest money first: the balance, then the first payment.
  const online = [];
  if (b.balanceOnline > 0) online.push({ kind: "balance", id: ids.balance, cap: b.balanceOnline });
  if (b.depositCollected > 0 && depositOnline) online.push({ kind: "deposit", id: ids.deposit, cap: b.depositCollected });

  const hit = online.find((o) => o.id && o.cap >= amount);
  if (hit) return { paymongo: { paymongoPaymentID: hit.id, kind: hit.kind } };

  const inStoreMoney = b.balanceInPerson + (depositOnline ? 0 : b.depositCollected);
  if (inStoreMoney >= amount) return { inStore: true };

  if (online.some((o) => !o.id)) {
    return { error: "This payment's PayMongo record is incomplete, so the discount can't be refunded automatically. Please check the payment in PayMongo first." };
  }
  return { error: "That discount is bigger than any single payment on this booking, so PayMongo can't refund it in one go. Give a smaller discount." };
};

// ─────────────────────────────────────────────
// Giving a discount. There is no edit and no correction, but MORE than one can be given: a discount that turned
// out too small is fixed by giving another, never by rewriting the first. Every discount is its own ledger row.
// The rules live in discountLedger.js; in short:
//
//   • Payment still partial  -> the discount comes off the REMAINING balance (it can't be more than that balance).
//                               Row: discount_applied_balance. Nothing was paid, so nothing is owed back.
//   • Payment fully paid     -> the customer already paid it, so it is HELD for them and goes back with the
//                               security deposit when the trip is settled. Row: discount_credit.
//                               Nothing moves now: no PayMongo call, so a refund can't fail while staff are being
//                               kind. Needs a held security deposit to return it with.
//   • All discounts together can't go past what the customer paid, and none can be given once the deposit is settled.
//
// The payment's discount fields and the ledger row are written in ONE transaction, so they can never disagree.
// Flat pesos only. Staff-only to call. Drivers don't handle payments, so they are not notified.
// ─────────────────────────────────────────────
export const applyDiscount = async (bookingID, amount, reason, appliedBy, actorID = null) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const discountAmount = Number(amount);
  if (!Number.isFinite(discountAmount) || discountAmount <= 0) {
    throw new Error("Enter a discount greater than ₱0.");
  }

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc = snap.docs[0];
  // Read through the entries: "balance collected in person" is not stored on the payment document.
  const existing = await hydratePaymentData(doc.data(), doc.id);

  const status = String(existing.status || "").toLowerCase();
  if (status === "refunded") {
    throw new Error("This payment has already been refunded — a discount can't be applied to it.");
  }
  if (status !== "paid" && status !== "approved") {
    throw new Error("A discount can only be given after the customer's first payment has been received through PayMongo.");
  }

  // Where it goes and how much it can be: the remaining balance while the payment is partial, otherwise what the
  // customer paid, less the discounts already given.
  const before = computeAmounts(existing);                                       // balance already net of earlier discounts
  const grossPaid = computeAmounts({ ...existing, discountAmount: 0 }).amountPaid;
  const figuresBefore = getDiscountFigures(existing);
  const dep = getDepositView(existing);
  const plan = planNewDiscount({
    amount: discountAmount,
    totalFee: Number(existing.amount) || 0,
    grossPaid,
    balance: before.balance,
    given: figuresBefore.total,
    depositStatus: dep ? dep.status : null,
    legacy: hasLegacyDiscount(existing),
  });
  if (!plan.ok) throw new Error(plan.error);
  const kind = plan.kind;   // "balance" | "credit"

  // Need the booking doc as a fallback source for the customer's userID
  // (see resolveCustomerUserID).
  const booking = await findBookingByBookingID(bookingID);

  // A refund request is open for this payment: changing the numbers now would disagree with it.
  const openRefundRequest = await findOpenRefundRequest(existing.paymentID || doc.id);
  if (openRefundRequest) {
    throw new Error(
      "A refund request is already open for this payment. " +
      "Resolve or cancel that refund request before giving a discount."
    );
  }

  // A balance checkout is open on PayMongo. PayMongo fixes the amount when the session is created,
  // so a discount given now could never reach what the customer is charged. Let it finish first.
  if (String(existing.balanceStatus || "").toLowerCase() === "pending") {
    throw new Error(
      "A balance payment is in progress on PayMongo for this booking. " +
      "Wait for it to finish (or fail) before giving a discount, so the customer is charged the right amount."
    );
  }

  const paymentID = existing.paymentID || doc.id;
  const customerUserID = resolveCustomerUserID(existing.userID, booking);
  const newFigures = applyNewDiscount(existing, kind, discountAmount);
  const now = new Date();
  const entryRef = db.collection(ENTRY_COLLECTION).doc();

  // The payment's figures and the ledger row, together. The transaction re-reads the payment: if another discount
  // (or anything else that moves the figures) landed since we read it, this one stops instead of overshooting the cap.
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(doc.ref);
    if (!cur.exists) throw new Error("No payment record found for this booking.");
    const c = getDiscountFigures(cur.data());
    if (c.total !== figuresBefore.total || c.ledger !== figuresBefore.ledger || c.credit !== figuresBefore.credit || c.applied !== figuresBefore.applied) {
      throw new Error("This booking's discount changed a moment ago. Please refresh and try again.");
    }
    tx.update(doc.ref, {
      ...newFigures,
      // Who gave it and when is on the ledger row below. The reason isn't stored: it is in the activity log.
      discountAt:     admin.firestore.FieldValue.serverTimestamp(),   // when the LATEST discount was given
      refundDue:      0,                                // nothing is handed back on the spot any more
      updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(entryRef, {
      paymentEntryID: entryRef.id,
      paymentID,
      bookingID,
      userID: existing.userID || customerUserID || null,
      refundReqID: null,
      penaltyID: null,
      direction: "internal",                            // no cash moved
      phase: kind === "balance" ? DISCOUNT_PHASES.appliedBalance : DISCOUNT_PHASES.credit,
      source: null,
      method: null,
      amount: discountAmount,
      status: "success",
      referenceNumber: null,
      sessionID: null,
      transactionFee: null,
      processedBy: actorID || appliedBy || null,         // the staff uid, like every other row
      processedAt: now,
      settledAt: now,
      groupID: null,
      transactionErrorNote: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  const after = computeAmounts({ ...existing, ...newFigures });
  const given = newFigures.discountAmount;
  const nth = figuresBefore.total > 0 ? " (an additional discount)" : "";

  // Bell ping to Owner/Admin/Supervisor for every discount.
  await notifyStaff({
    type: "discount_applied",
    refID: bookingID,
    refCollection: "bookings",
    title: "Discount Applied",
    message: `A discount of ₱${discountAmount.toLocaleString()} was applied to booking ${bookingID}${nth}${reason ? ` (${reason})` : ""}. ${
      kind === "credit" ? "The booking was already fully paid, so it is held and returns with the security deposit." : `The remaining balance is now ₱${after.balance.toLocaleString()}.`}`,
  });

  // Customer-facing bell: what the discount did for THEM.
  await notifyCustomer(
    customerUserID, bookingID, "discount_applied", "Discount Applied",
    kind === "credit"
      ? `A discount of ₱${discountAmount.toLocaleString()} was applied to your booking ${bookingID}. Since you've already paid in full, it will be returned to you together with your security deposit after your trip.`
      : `A discount of ₱${discountAmount.toLocaleString()} was applied to your booking ${bookingID}. Your remaining balance is now ₱${after.balance.toLocaleString()}.`
  );

  createTransactionLog({
    bookingID,
    paymentID,
    userID: customerUserID,
    type: "Discount",
    amount: discountAmount,
    status: "Success",
    description: `Discount of ₱${discountAmount.toLocaleString()} given on booking ${bookingID}${reason ? `: ${reason}` : ""}${
      kind === "credit" ? " (held, returns with the security deposit)" : " (taken off the remaining balance)"}.`,
    performedBy: appliedBy || "—",
  });

  auditSafe({
    action: "update",
    description: `Discount of ₱${discountAmount.toLocaleString()} given on booking ${bookingID}${nth}${reason ? ` (${reason})` : ""}${
      kind === "credit" ? `; held for the customer, returns with the security deposit (₱${given.toLocaleString()} discounts in total)` : `; remaining balance is now ₱${after.balance.toLocaleString()}`}.`,
    userID: appliedBy || null,
    bookingID,
    paymentID,
  });

  return {
    id: doc.id, bookingID, discountAmount,
    discountTotal: given,
    kind,                                   // "balance" | "credit"
    creditHeld: newFigures.discountCredit,
    balanceAfter: after.balance,
  };
};

// ─────────────────────────────────────────────
// "Notify customer to pay" the remaining balance.
//
// The balance is paid online (PayMongo) from the customer's own booking. This just nudges them
// with a bell notification. It can't be spammed: one reminder per booking every 6 hours.
// ─────────────────────────────────────────────
const BALANCE_REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const notifyBalanceDue = async (bookingID, notifiedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");

  const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) throw new Error("No payment record found for this booking.");
  const doc = snap.docs[0];
  const data = await hydratePaymentData(doc.data(), doc.id);

  const status = String(data.status || "").toLowerCase();
  if (status !== "paid" && status !== "approved") {
    throw new Error("The first payment hasn't been received yet — there is no remaining balance to remind about.");
  }
  const balanceStatus = String(data.balanceStatus || "").toLowerCase();
  if (balanceStatus === "pending") {
    throw new Error("The customer already has a balance payment in progress on PayMongo.");
  }
  const { balance } = computeAmounts(data);
  if (balanceStatus === "paid" || balance <= 0) {
    throw new Error("There is no remaining balance on this booking.");
  }
  if (await findOpenRefundRequest(data.paymentID || doc.id)) {
    throw new Error("A refund request is open for this booking — resolve it before asking for the balance.");
  }

  const last = data.balanceReminderAt?.toDate ? data.balanceReminderAt.toDate()
             : data.balanceReminderAt ? new Date(data.balanceReminderAt) : null;
  if (last && Date.now() - last.getTime() < BALANCE_REMINDER_COOLDOWN_MS) {
    const err = new Error("The customer was already reminded recently. Please wait before sending another reminder.");
    err.status = 429;
    err.retryAfterSeconds = Math.ceil((BALANCE_REMINDER_COOLDOWN_MS - (Date.now() - last.getTime())) / 1000);
    err.lastNotifiedAt = last.toISOString();
    throw err;
  }

  const booking = await findBookingByBookingID(bookingID);
  const customerUserID = resolveCustomerUserID(data.userID, booking);
  if (!customerUserID) throw new Error("This booking has no customer account to notify.");

  await notifyCustomer(
    customerUserID, bookingID, "balance_reminder", "Remaining balance due",
    `Please pay the remaining ₱${balance.toLocaleString()} for your booking ${bookingID}. You can pay it online from your booking.`
  );

  // The same reminder by email. Awaited (not fire-and-forget) so a serverless host can't cut it off and so
  // staff are told whether it went out. A failed or impossible email never fails the reminder itself:
  // the bell notification above has already been sent.
  let emailed = false;
  let emailNote = null;
  try {
    const { email, name } = await resolveCustomerContact(customerUserID);
    if (!email) {
      emailNote = "This customer has no email address on file.";
    } else {
      const result = await sendBalanceReminderEmail({ toEmail: email, toName: name, bookingID, balance });
      emailed = !!result.success;
      if (!emailed) emailNote = "The email service could not send it.";
    }
  } catch (err) {
    console.error("[PAYMENTS] balance reminder email failed:", err.message);
    emailNote = "The email could not be sent.";
  }

  await doc.ref.update({
    balanceReminderAt: admin.firestore.FieldValue.serverTimestamp(),
    balanceReminderBy: notifiedBy || null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  auditSafe({
    action: "update",
    description: `Customer reminded to pay the remaining ₱${balance.toLocaleString()} for booking ${bookingID} (in the app${emailed ? " and by email" : "; email not sent"}).`,
    userID: notifiedBy || null,
    bookingID,
    paymentID: data.paymentID || doc.id,
  });

  return { bookingID, balance, notifiedAt: new Date().toISOString(), emailed, emailNote };
};

// Every discount that sent (or still has to send) money back to the customer, with where that money stands. The
// Refunds page lists these next to the refund requests, because both are "money going back" and both wait on PayMongo.
// A discount that just came off the remaining balance moved no money, so it is not listed.
export const getDiscountRefunds = async () => {
  const snap = await db.collection("payments").where("discountAmount", ">", 0).get();
  const docs = await hydratePayments(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  const keys = docs.map((d) => d.paymentID || d.id);
  const entries = keys.length ? await getEntriesForPaymentIDs(keys) : new Map();
  const items = [];
  for (const payment of docs) {
    const key = payment.paymentID || payment.id;
    const refund = deriveDiscountRefund(payment, entries.get(key) || []);
    if (!refund || refund.state === "deducted") continue;
    // A ledger discount only belongs here once its credit has a payout (processing / failed / returned). While it is
    // still held, nothing is owed yet, so there is nothing to follow up on this page.
    const ledger = !!(refund.view && refund.view.ledger);
    if (ledger && refund.state === "held") continue;
    const booking = payment.bookingID ? await findBookingByBookingID(payment.bookingID) : null;
    items.push({
      paymentID: key,
      bookingID: payment.bookingID || null,
      customerName: await resolveCustomerName(resolveCustomerUserID(payment.userID, booking)),
      discountAmount: Number(payment.discountAmount) || 0,
      discountReason: payment.discountReason || "",
      discountAt: isoOf(payment.discountAt),
      ledger,                                   // true: the credit goes back through the deposit-return retry, not the legacy one
      refund,
    });
  }
  return items;
};

// ─────────────────────────────────────────────
// Retry a discount refund that PayMongo accepted and then FAILED. The customer is still owed that money, and the
// failed row stays on the ledger as the record of what happened; a new PayMongo refund is made and written as a
// new "pending" row (the newest row wins -- see deriveDiscountRefund). Nothing is retried while one is in flight
// or after it succeeded, so the same money can never be refunded twice.
// ─────────────────────────────────────────────
export const retryDiscountRefund = async (bookingID, retriedBy) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) throw new Error("No payment record found for this booking.");
  const doc = snap.docs[0];
  const payment = await hydratePaymentData(doc.data(), doc.id);

  if (getDiscountFigures(payment).ledger) {
    throw new Error("This discount's credit goes back with the deposit return: retry it from there (PATCH /api/bookings/:id/deposit-return/retry), not here.");
  }
  const state = await getDiscountRefundState(payment, doc.id);
  if (!state || state.state !== "failed") {
    throw new Error(
      state && state.state === "processing" ? "This discount's refund is still processing at PayMongo — wait for it to finish."
      : state && state.state === "refunded"  ? "This discount has already been refunded."
      : "There is no failed discount refund to retry on this booking."
    );
  }
  if (String(payment.status || "").toLowerCase() === "refunded") throw new Error("This payment has already been refunded.");

  const amount = state.amount;
  const plan = planDiscountRefund(payment, amount);
  if (plan.error) throw new Error(plan.error);
  if (!plan.paymongo) throw new Error("This discount was paid in store, so it can't be retried through PayMongo. Hand it back in store instead.");

  const paymentID = payment.paymentID || doc.id;
  const refundID = await createPaymongoRefund({
    paymongoPaymentID: plan.paymongo.paymongoPaymentID,
    amount,
    reason: `Discount for booking ${bookingID} (retry)`,
  });

  const now = new Date();
  const entryRef = db.collection(ENTRY_COLLECTION).doc();
  await entryRef.set({
    paymentEntryID: entryRef.id, paymentID, bookingID,
    userID: payment.userID || null, refundReqID: null, penaltyID: null,
    direction: "out", phase: "discount", source: "online", method: null,
    amount, status: "pending", referenceNumber: refundID,
    sessionID: null, transactionFee: null,
    processedBy: retriedBy || null, processedAt: now, settledAt: null,
    groupID: null, transactionErrorNote: null, createdAt: now, updatedAt: now,
  });

  auditSafe({
    action: "update",
    description: `Discount refund of ₱${amount.toLocaleString()} retried through PayMongo for booking ${bookingID} (new ref ${refundID}); the earlier attempt had failed.`,
    userID: retriedBy || null, bookingID, paymentID,
  });
  return { bookingID, amount, refundID };
};

// ─────────────────────────────────────────────
// A refund that could NOT go back through PayMongo (the money was received in store) is handed
// back in store. A Supervisor / Admin / Owner records it here with how it was returned and, for
// anything but cash, the reference number. Drivers no longer do this.
// Resolves the refund_due notification once marked.
// ─────────────────────────────────────────────
export const markRefundIssued = async (bookingID, issuedBy, details = {}) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const method = details.paymentMethod || "Cash";
  assertValidPaymentMethod(method);
  const reference = cleanReference(method, details.referenceNumber);

  const snap = await db.collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("No payment record found for this booking.");

  const doc  = snap.docs[0];
  const data = await hydratePaymentData(doc.data(), doc.id);   // balanceCollected comes from the balance row

  const { refundDue } = computeAmounts(data);
  if (refundDue <= 0) {
    throw new Error("There is no refund due on this booking.");
  }
  // The row below has an auto ID, so guard against recording the same hand-back twice.
  if (data.refundIssued) {
    throw new Error("This refund has already been marked as handed back.");
  }

  const paymentID = data.paymentID || doc.id;

  // The cash handed back is money OUT, so it gets its own paymentEntries row -- otherwise the entry ledger
  // would never see that this money left. Same shape as a refund's in-person hand-back (<id>_manual), but it
  // hangs off the payment (paymentID only, refundReqID stays null), because no request exists for a
  // discount spillover; phase "discount" marks it. It is committed in the same batch as refundIssued, so the
  // flag and the ledger can never disagree.
  const batch = db.batch();
  // Who handed it back and when are NOT stored on the payment: they are the out-row's processedBy / processedAt.
  batch.update(doc.ref, {
    refundIssued:   true,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  });
  const now = new Date();
  const handBackRef = db.collection(ENTRY_COLLECTION).doc();
  batch.set(handBackRef, {
    paymentEntryID: handBackRef.id,
    paymentID,
    bookingID,
    userID: data.userID || null,
    refundReqID: null,
    penaltyID: null,
    direction: "out",
    phase: "discount",
    source: "in_person",
    method: method.toLowerCase().replace(/\s+/g, "_"),
    amount: refundDue,
    status: "success",
    referenceNumber: reference,
    sessionID: null,
    transactionFee: null,
    processedBy: issuedBy || null,
    processedAt: now,
    settledAt: now,
    groupID: null,
    transactionErrorNote: null,
    createdAt: now,
    updatedAt: now,
  });
  await batch.commit();

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
    paymentMethod: method,
    referenceNumber: reference,
    description: `Discount refund of ₱${refundDue.toLocaleString()} returned to customer in store for booking ${bookingID} via ${method}${reference ? ` (ref ${reference})` : ""}.`,
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
  // Read through paymentEntries: the PayMongo ids, fees, channel, confirmedBy ... come back from the rows
  // even after the cleanup removed them from the document. One query per 30 payments, not one per payment.
  const docs = await hydratePayments(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));

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

  // One lookup for every discounted payment, so the list can show "refund processing" without a query per row.
  const discounted = docs.filter((d) => Number(d.discountAmount) > 0).map((d) => d.paymentID || d.id);
  const entriesByPayment = discounted.length ? await getEntriesForPaymentIDs(discounted) : new Map();

  return withStaffNames(docs.map((payment) => {
    const booking = bookingMap[payment.bookingID] || {};
    const vehicleName = vehicleMap[booking.carID] || "—";
    const customerName = nameMap[booking.userID] || "—";
    const key = payment.paymentID || payment.id;
    return buildPaymentRow(payment, booking, customerName, vehicleName, openRefundByPayment[key] || null, deriveDiscountRefund(payment, entriesByPayment.get(key) || []));
  }));
};

export const updatePaymentStatus = async (id, status, performedBy = null) => {
  const allowed = ["Pending", "Approved", "Rejected", "Cancelled"];
  if (!allowed.includes(status)) throw new Error("Invalid status.");
  // Every payment goes through PayMongo, which confirms it by itself the moment the customer pays.
  // Staff can no longer mark a payment as received by hand.
  if (status === "Approved") {
    throw new Error("Payments can't be approved by hand any more. They are marked as paid automatically when the customer pays through PayMongo.");
  }

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

  // Approving a payment by hand means staff have the money, so record WHO and WHEN on the entry row (they no
  // longer live on the payment document). An earlier confirmation is kept: hydrate reads it back from the
  // row, so a second Approve click can't overwrite whoever confirmed it first.
  let entryFields;
  if (status === "Approved") {
    const prior = await hydratePaymentData(existing, id);
    if (!prior.confirmedBy) entryFields = { confirmedBy: performedBy || "—", confirmedAt: new Date() };
  }

  // A deliberate manual change by staff may move an entry out of "success" (a late webhook may not).
  await syncPaymentEntries(id, entryFields ? { force: true, fields: entryFields } : { force: true });

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

// Every penalty charged on this payment, as a light summary for the Payments modal's "Penalty Breakdown".
// Read straight from `penalties` (matched on paymentID): amount / paidAmount / status are stored on the penalty,
// so nothing needs hydrating. Oldest first, so the list reads in the order the charges happened.
const getPenaltySummaries = async (paymentID) => {
  if (!paymentID) return [];
  const snap = await db.collection("penalties").where("paymentID", "==", paymentID).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0))
    .map((p) => ({
      penaltyID: p.penaltyID || p.id,
      description: (p.lineItems || []).map((i) => i.description).filter(Boolean).join(", ") || "Penalty",
      amount: Number(p.amount) || 0,
      paidAmount: Number(p.paidAmount) || 0,
      gatewayFeeRate: p.gatewayFeeRate ?? null,   // online payment fee % saved when the penalty was created
      gatewayFeePaid: Number(p.gatewayFeePaid) || 0, // online payment fee the customer has paid on it so far (on top of paidAmount)
      status: p.status || "Confirmed",            // Confirmed | Voided | Waived
      statusReason: p.statusReason || "",
      createdAt: isoOf(p.createdAt),
    }));
};

export const getPaymentById = async (id) => {
  const doc = await db.collection("payments").doc(id).get();
  if (!doc.exists) throw new Error("Payment not found.");
  const payment = { id: doc.id, ...(await hydratePaymentData(doc.data(), doc.id)) };

  const booking = payment.bookingID
    ? (await db.collection("bookings").doc(payment.bookingID).get())
    : null;
  const bookingData = booking?.exists ? booking.data() : {};

  const [customerName, vehicleName] = await Promise.all([
    resolveCustomerName(bookingData.userID),
    resolveVehicleName(bookingData.carID),
  ]);

  const openRefund = await findOpenRefundRequest(payment.paymentID || payment.id);
  const discountRefund = await getDiscountRefundState(payment, payment.id);
  const [row, penalties] = await Promise.all([
    withStaffNames(buildPaymentRow(payment, bookingData, customerName, vehicleName, openRefund, discountRefund)),
    getPenaltySummaries(payment.paymentID || payment.id),
  ]);
  // Gateway Breakdown, penalty side: the fee the customer paid comes from the penalties (gatewayFeePaid), what PayMongo kept
  // from the penalty entries. null when no penalty was paid online.
  const r2 = (n) => Math.round(n * 100) / 100;
  const feeReceived = r2(penalties.reduce((s, p) => s + (p.gatewayFeePaid || 0), 0));
  const fromEntries = row.penaltyGateway || null;
  const penaltyGateway = fromEntries || feeReceived > 0
    ? {
        received: feeReceived,
        paymongoFee: fromEntries ? fromEntries.paymongoFee : null,
        charged: r2((fromEntries ? fromEntries.paid : 0) + feeReceived),   // penalty money + the fee, i.e. what the customer paid
        count: fromEntries ? fromEntries.count : 0,
      }
    : null;
  // Who gave / used each discount: the ledger rows carry the staff uid.
  let discount = row.discount;
  if (discount && Array.isArray(discount.events) && discount.events.length) {
    const ids = [...new Set(discount.events.map((e) => e.by).filter((v) => v && v !== "—" && !String(v).includes("@")))];
    const names = ids.length ? await resolveUserNames(ids).catch(() => ({})) : {};
    discount = { ...discount, events: discount.events.map((e) => ({ ...e, byName: names[e.by] || e.by || null })) };
  }
  return { ...row, discount, penalties, penaltyGateway };
};

// Same full detail as getPaymentById() above (discounts, the deposit/balance
// timeline, payment stage), just looked up by a booking's OWN bookingID
// field instead of the payment doc's Firestore id — bookings only carry the
// former. Reuses buildPaymentRow() so this can never drift out of sync with
// what the main Payments page shows for the same payment. Used by Fleet.jsx's
// per-booking confirm modal (status-change → refund flow) so staff see the
// real payment history before confirming, not a stripped-down summary.
export const getPaymentDetailsByBookingID = async (bookingID) => {
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (paymentSnap.empty) return null;
  const payment = { id: paymentSnap.docs[0].id, ...(await hydratePaymentData(paymentSnap.docs[0].data(), paymentSnap.docs[0].id)) };

  const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  const bookingData = bookingSnap.empty ? {} : bookingSnap.docs[0].data();

  const [customerName, vehicleName] = await Promise.all([
    resolveCustomerName(bookingData.userID),
    resolveVehicleName(bookingData.carID),
  ]);

  const openRefund = await findOpenRefundRequest(payment.paymentID || payment.id);
  const discountRefund = await getDiscountRefundState(payment, payment.id);
  return withStaffNames(buildPaymentRow(payment, bookingData, customerName, vehicleName, openRefund, discountRefund));
};