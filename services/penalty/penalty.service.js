import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  PENALTY_STATUSES,
  PENALTY_SHORTFALL_METHODS,
  createPenaltyPayload,
} from "../../models/penalty/penalty.model.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { createNotification, notifyStaff } from "../notification/notification.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";
import { getSessionByBookingID } from "../booking/bookingSession.service.js";
import { resolveCurrentDriverID } from "../driverAssignments/driverAssignments.service.js";
import { ENTRY_COLLECTION, ENTRY_METHODS } from "../../models/paymentEntries/paymentEntry.model.js";
import { buildPenaltyPaymentEntry } from "../paymentEntries/paymentEntries.mapper.js";
import { getDepositView } from "../payments/paymentHelpers.js";
import { creditDrawFor, applyCreditToPenalty, applySettlement, planSettlement, getDiscountFigures, DISCOUNT_PHASES } from "../payments/discountLedger.js";
import { hydratePenalties } from "../paymentEntries/paymentEntries.service.js";

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// dedupeKey = the penaltyID: refID is the BOOKING (so the bell still links to it), and a booking can have several
// penalties. Without the key, only the first penalty's notification was ever created while it was still unread /
// active; every later penalty (and every later waive / void) on that booking was silently dropped.
const notifyCustomer = (userID, bookingID, type, title, message, dedupeKey = null) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID, dedupeKey })
    .catch((err) => console.error(`[PENALTY] failed to notify customer (${type}):`, err.message));
};

// Fans out to every Owner/Admin/Supervisor when a penalty is charged straight
// away (one a Supervisor / Admin / Owner logged themselves, which has no
// review step), so the others find out and can void/waive it if it's wrong.
// Penalties a Driver logs go through review instead: see notifyStaffOfReview.
const notifyStaffOfPenalty = (bookingID, penaltyID, amount, itemNames) =>
  notifyStaff({
    type: "penalty_created",
    refID: penaltyID,
    refCollection: "penalties",
    title: "A penalty was charged",
    message: `₱${amount} was charged on booking ${bookingID} and the customer was notified — ${itemNames}.`,
  }).catch((err) => console.error("[PENALTY] failed to notify staff:", err.message));

// A Driver noted a penalty: nobody has signed off on it and the customer has NOT been told. This is the "to approve" ping
// supervisors get; notifyStaffOfPenalty above is the "it went out" one for penalties confirmed on creation / on review.
const notifyStaffOfReview = (bookingID, penaltyID, amount, itemNames) =>
  notifyStaff({
    type: "penalty_review",
    refID: penaltyID,
    refCollection: "penalties",
    title: "A penalty needs review",
    message: `A driver noted ₱${amount} on booking ${bookingID} — ${itemNames}. The customer hasn't been notified yet: review and confirm it on the Penalties page.`,
  }).catch((err) => console.error("[PENALTY] failed to notify staff of a penalty to review:", err.message));

const getBookingDoc = async (bookingID) => {
  const snap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
};

const getPaymentDoc = async (paymentID) => {
  const ref = db.collection("payments").doc(paymentID);
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() } : null;
};

// The booking doc does NOT store paymentID — it's the payment doc that
// stores bookingID (see customer-backend's createBooking, which writes
// { paymentID, bookingID, ... } onto a fresh payments/{auto-id} doc).
// This is the correct lookup direction; do not read booking.data.paymentID
// anywhere, it doesn't exist.
const getPaymentByBookingID = async (bookingID) => {
  const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? null : { ref: snap.docs[0].ref, data: snap.docs[0].data() };
};

// True when this booking is assigned to the given driver. Used by the
// penalty controller to keep a Driver's booking-scoped calls (create, late-fee
// suggestion, list) to their own trips — the driver-dispatch routes already
// enforce this per trip, this covers the general /api/penalties routes.
export const isBookingAssignedTo = async (bookingID, uid) => {
  if (!bookingID || !uid) return false;
  const booking = await getBookingDoc(bookingID);
  if (!booking) return false;
  return (await resolveCurrentDriverID(booking.data, bookingID)) === uid;
};

// ─────────────────────────────────────────────
// Late-fee calculation
//
// Grace is subtracted first, then the remainder is rounded UP to the next
// hour — a 40-minute-late return with a 30-minute grace bills 1 hour, not
// 0. Returns null lateMinutes (and a 0 amount) if the car wasn't actually
// late, so callers can tell "not late" apart from "late but grace covered
// it" if needed.
// ─────────────────────────────────────────────
export const computeLateFee = ({ scheduledEndAt, actualReturnAt, graceMinutes, ratePerHour }) => {
  const scheduled = scheduledEndAt instanceof Date ? scheduledEndAt : scheduledEndAt?.toDate?.();
  const actual    = actualReturnAt instanceof Date ? actualReturnAt : actualReturnAt?.toDate?.();
  if (!scheduled || !actual) return { lateMinutes: 0, billableHours: 0, computedAmount: 0 };

  const lateMinutes = Math.max(0, Math.round((actual.getTime() - scheduled.getTime()) / 60000));
  const billableMinutes = Math.max(0, lateMinutes - (graceMinutes || 0));
  const billableHours = billableMinutes > 0 ? Math.ceil(billableMinutes / 60) : 0;
  const computedAmount = billableHours * (ratePerHour || 0);

  return { lateMinutes, billableHours, computedAmount };
};

// Preview a booking's late fee against the CURRENT system settings and
// its own droppedOffTime. This is only a SUGGESTION now: the Penalties
// form and the driver's "Note a penalty" form show the end time, the
// drop-off time and "N hours late: ₱X" next to the fields, and whoever
// is charging types the amount themselves — nothing is auto-filled or
// auto-added, so it can't be used blindly and there's no late-fee button.
//
// Every booking type now uses the single droppedOffTime stamped on the
// bookingSession when the vehicle itself is physically dropped off — this
// used to branch on modeOfDriving and read a customerDroppedOffAt field
// straight off the *bookings* collection for chauffeur trips, but that
// field only ever lived on the bookingSession doc, never on the booking
// doc itself, so that branch silently computed 0 for every chauffeur
// booking. Reading the session directly fixes that as well as unifying
// the two paths into one.
export const previewLateFeeForBooking = async (bookingID) => {
  const booking = await getBookingDoc(bookingID);
  if (!booking) return null;

  const settings = await getSystemSettings();
  const graceMinutes = Number(settings.lateFeeGraceMinutes ?? 30);
  const ratePerHour   = Number(settings.lateFeeRatePerHour ?? 100);

  const session = await getSessionByBookingID(bookingID);
  const actualReturnAt = session?.data?.droppedOffTime || booking.data.completedAt;

  const { lateMinutes, billableHours, computedAmount } = computeLateFee({
    scheduledEndAt: booking.data.endDateTime,
    actualReturnAt,
    graceMinutes,
    ratePerHour,
  });

  // The two times behind the number, so the penalty forms can show staff
  // "ends at X, dropped off at Y" next to the suggestion instead of just a
  // total. actualReturnAt is null until the car has actually been dropped off.
  const iso = (v) => {
    const d = v instanceof Date ? v : v?.toDate?.();
    return d ? d.toISOString() : null;
  };

  return {
    bookingID, lateMinutes, billableHours, graceMinutes, ratePerHour, computedAmount,
    scheduledEndAt: iso(booking.data.endDateTime),
    actualReturnAt: iso(actualReturnAt),
    deposit: await describeDepositForPenalty(bookingID),
  };
};

// Where the security deposit stands for this booking, so a penalty form can tell staff how a new penalty gets paid:
//   returned = false  the deposit is still held: a confirmed penalty is deducted from it when the deposit is settled
//                     (availableForNew = what is left after the penalties already waiting on it)
//   returned = true   the deposit is already settled / refunded / forfeited / waived, or there never was one:
//                     nothing to deduct from, the customer is asked to pay the penalty online (or in store)
// Penalties UnderReview don't count: they aren't charged until confirmed.
const describeDepositForPenalty = async (bookingID) => {
  const payment = await getPaymentByBookingID(bookingID);
  const dep = payment ? getDepositView(payment.data) : null;
  if (!dep || !(Number(dep.amount) > 0)) {
    return { exists: false, returned: true, status: dep?.status || null, amount: 0, availableForNew: 0, reason: "none" };
  }
  const held = dep.status === "Held" && !dep.settlement;
  if (!held) {
    return {
      exists: true, returned: true, status: dep.status, amount: dep.amount,
      returnedAmount: Number(dep.returnedAmount) || 0, deducted: Number(dep.deducted) || 0, availableForNew: 0,
      reason: dep.status === "Settled" ? "settled" : String(dep.status || "closed").toLowerCase(),
    };
  }
  const penalties = await listPenaltiesForBooking(bookingID);
  const unpaid = penalties
    .filter((p) => p.status === "Confirmed")
    .reduce((sum, p) => sum + Math.max(0, (p.amount || 0) - (p.paidAmount || 0)), 0);
  return {
    exists: true, returned: false, status: dep.status, amount: dep.amount,
    alreadyClaimed: unpaid + (dep.applied || 0), availableForNew: Math.max(0, dep.amount - (dep.applied || 0) - unpaid), reason: "held",
  };
};

// ─────────────────────────────────────────────
// Creation. A penalty a Supervisor / Admin / Owner logs is Confirmed and the customer notified immediately. A penalty
// a Driver logs (needsReview) is saved as UnderReview instead: the customer is NOT notified, it counts toward nothing
// (deposit math, settlement, receipts and the customer's balance only ever look at Confirmed), and staff get a
// "needs review" notification. A supervisor then edits it if needed and confirms it (confirmPenalty below), which is
// the moment the customer hears about it.
// ─────────────────────────────────────────────

// Validates a set of charges and works out the money. Shared by create and edit so both enforce the same rules.
// Money is validated HERE, never trusted from the browser: the customer is billed from these numbers (online, with the
// payment fee on top), so the server works out the total itself from the line items.
const round2 = (v) => Math.round(v * 100) / 100;
const buildCharge = ({ lineItems, amount, overrideReason = "" }) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { error: "At least one line item is required." };
  }
  if (lineItems.some((item) => typeof item?.description !== "string" || !item.description.trim())) {
    return { error: "Every line item needs a description." };
  }
  const items = [];
  for (const item of lineItems) {
    const itemAmount = Number(item.amount);
    if (!Number.isFinite(itemAmount) || itemAmount <= 0) {
      return { error: `Every line item needs an amount greater than \u20b10 ("${item.description.trim()}").` };
    }
    items.push({ ...item, description: item.description.trim(), amount: round2(itemAmount) });
  }
  // computedAmount is the sum of the line items as the SERVER adds them; whatever the client sent is ignored.
  const computedAmount = round2(items.reduce((sum, item) => sum + item.amount, 0));

  const finalAmount = amount === undefined || amount === null || amount === "" ? computedAmount : Number(amount);
  if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
    return { error: "The penalty amount must be a number greater than \u20b10." };
  }
  const roundedFinal = round2(finalAmount);
  if (roundedFinal !== computedAmount && !String(overrideReason || "").trim()) {
    return { error: "A reason is required when the amount is adjusted from the line-item total." };
  }
  return { items, computedAmount, amount: roundedFinal, overrideReason: String(overrideReason || "").trim() };
};

// The online payment fee % as of NOW (same System Settings value the booking uses). It only applies if the customer
// pays this penalty online; see gatewayFeeRate in penalty.model.js.
const currentGatewayFeeRate = async () => {
  const settings = await getSystemSettings();
  return Math.min(100, Math.max(0, Number(settings.gatewayFeePercent) || 0));
};

// Late fees are no longer a special kind of penalty: staff and drivers type
// every charge by hand (the late-fee preview above is only a suggestion shown
// next to the form). That's why there's no lateMinutes/graceMinutes/rate here
// anymore and no one-per-booking ID — a late charge can be voided and
// charged again like any other line.
export const createPenalty = async ({
  bookingID, lineItems = [],
  computedAmount: _clientComputed, amount, overrideReason = "", createdBy, needsReview = false, deductFromDeposit = true,
}) => {
  const charge = buildCharge({ lineItems, amount, overrideReason });
  if (charge.error) return { error: charge.error };
  const { items, computedAmount, amount: roundedFinal } = charge;
  overrideReason = charge.overrideReason;

  const booking = await getBookingDoc(bookingID);
  if (!booking) return { error: "Booking not found." };

  const payment = await getPaymentByBookingID(bookingID);
  if (!payment) return { error: "No payment record found for this booking." };

  const ref = db.collection("penalties").doc();

  const now = timestamp();
  const payload = createPenaltyPayload(ref.id, {
    gatewayFeeRate: await currentGatewayFeeRate(),
    bookingID,
    paymentID: payment.data.paymentID || payment.ref.id,
    userID:    booking.data.userID    || null,
    carID:     booking.data.carID     || null,
    lineItems: items,
    computedAmount, amount: roundedFinal, overrideReason,
    status: needsReview ? "UnderReview" : "Confirmed",
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  await ref.set(payload);

  const itemNames = items.map((i) => i.description).join(", ");

  if (needsReview) {
    // Nothing goes to the customer: this is only a draft until a supervisor confirms it.
    createAuditLog?.({
      action: "create", userID: createdBy,
      bookingID, paymentID: payload.paymentID,
      description: `Noted penalty of \u20b1${roundedFinal} on booking ${bookingID} for review (customer not notified yet): ${itemNames}.`,
    }).catch(() => {});
    await notifyStaffOfReview(bookingID, ref.id, roundedFinal, itemNames);
    return { penaltyID: ref.id, status: "UnderReview" };
  }

  createAuditLog?.({
    action: "create", userID: createdBy,
    bookingID, paymentID: payload.paymentID,
    description: `Charged penalty of \u20b1${roundedFinal} on booking ${bookingID}: ${itemNames}.`,
  }).catch(() => {});

  // The held deposit pays it right now: paidAmount goes up, so it reads Paid (or Partially Paid) instead of Pending.
  let deducted = 0;
  let deductedFromCredit = 0;
  if (deductFromDeposit !== false) {
    try { const r = await applyPenaltyToDeposit(ref.id, createdBy); deducted = r.applied || 0; deductedFromCredit = r.fromCredit || 0; }
    catch (err) { console.error("[PENALTY] deposit deduction failed:", err.message); }
  }

  await notifyCustomer(
    payload.userID, bookingID, "PenaltyConfirmed",
    "A charge was added to your booking",
    `A ₱${roundedFinal} charge was added to your recent booking — ${itemNames}. See your booking details for the breakdown.`,
    ref.id
  );
  await notifyStaffOfPenalty(bookingID, ref.id, roundedFinal, itemNames);

  return { penaltyID: ref.id, status: "Confirmed", deductedFromDeposit: deducted, deductedFromDiscountCredit: deductedFromCredit };
};

// Reads a penalty inside a transaction and hands it to `apply` only while it is still UnderReview. Used by edit and
// confirm so two supervisors acting at once can't edit a penalty after the other one confirmed (and notified) it.
const withUnderReview = async (penaltyID, lockedMessage, apply) => {
  const ref = db.collection("penalties").doc(penaltyID);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw Object.assign(new Error("Penalty not found."), { expected: true });
      const data = snap.data();
      if (data.status !== "UnderReview") throw Object.assign(new Error(lockedMessage(data.status)), { expected: true });
      return apply({ tx, ref, data });
    });
  } catch (err) {
    if (err.expected) return { error: err.message };
    throw err;
  }
};

// Edit a penalty that is still UnderReview: change descriptions / amounts, add or remove line items, adjust the
// total. Supervisor / Admin / Owner only (routes). Once it is confirmed the customer has been told, so it is locked.
export const editPenalty = async (penaltyID, { lineItems, amount, overrideReason = "" } = {}, actorUid = null) => {
  const charge = buildCharge({ lineItems, amount, overrideReason });
  if (charge.error) return { error: charge.error };

  const result = await withUnderReview(
    penaltyID,
    (status) => status === "Confirmed"
      ? "This penalty was already confirmed and the customer notified, so it can't be edited anymore."
      : `This penalty is ${status} and can't be edited.`,
    ({ tx, ref, data }) => {
      tx.update(ref, {
        lineItems: charge.items,
        computedAmount: charge.computedAmount,
        amount: charge.amount,
        overrideReason: charge.overrideReason,
        editedBy: actorUid || null,
        editedAt: timestamp(),
        updatedAt: timestamp(),
      });
      return { before: data };
    }
  );
  if (result.error) return result;

  const itemNames = charge.items.map((i) => i.description).join(", ");
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: result.before.bookingID, paymentID: result.before.paymentID,
    description: `Edited penalty ${penaltyID} on booking ${result.before.bookingID} before it was confirmed: now \u20b1${charge.amount} — ${itemNames} (was \u20b1${result.before.amount}).`,
  }).catch(() => {});

  return { penaltyID };
};

// Confirm a penalty that is UnderReview: this is the moment the customer is notified, and the moment it becomes
// locked and starts counting (deposit math, settlement, receipts, the customer's balance).
export const confirmPenalty = async (penaltyID, actorUid = null) => {
  // Fee % re-read now: the customer's terms are fixed when they are told, not when a driver first typed the charge.
  const gatewayFeeRate = await currentGatewayFeeRate();

  const result = await withUnderReview(
    penaltyID,
    (status) => status === "Confirmed"
      ? "This penalty is already confirmed."
      : `This penalty is ${status} and can't be confirmed.`,
    ({ tx, ref, data }) => {
      tx.update(ref, {
        status: "Confirmed",
        gatewayFeeRate,
        confirmedBy: actorUid || null,
        confirmedAt: timestamp(),
        updatedAt: timestamp(),
      });
      return { penalty: data };
    }
  );
  if (result.error) return result;

  const p = result.penalty;
  const itemNames = (p.lineItems || []).map((i) => i.description).join(", ");

  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: p.bookingID, paymentID: p.paymentID,
    description: `Confirmed penalty of \u20b1${p.amount} on booking ${p.bookingID} (penalty ${penaltyID}) and notified the customer: ${itemNames}.`,
  }).catch(() => {});

  await notifyCustomer(
    p.userID, p.bookingID, "PenaltyConfirmed",
    "A charge was added to your booking",
    `A ₱${p.amount} charge was added to your recent booking — ${itemNames}. See your booking details for the breakdown.`,
    penaltyID
  );

  // Same as a penalty confirmed on creation: the held deposit pays it now.
  let deducted = 0;
  let deductedFromCredit = 0;
  try { const r = await applyPenaltyToDeposit(penaltyID, actorUid); deducted = r.applied || 0; deductedFromCredit = r.fromCredit || 0; }
  catch (err) { console.error("[PENALTY] deposit deduction failed:", err.message); }

  return { penaltyID, deductedFromDeposit: deducted, deductedFromDiscountCredit: deductedFromCredit };
};

// ─────────────────────────────────────────────
// Deducting a confirmed penalty from the held deposit, right when it is confirmed.
// Raises the penalty's paidAmount (so it reads Paid / Partially Paid, not Pending) and adds the pesos used to
// payments.depositSettled. settleBooking() later counts that as already used, so nothing is taken twice.
// What the deposit can't cover is paid from the discount credit held for the customer (if there is any): the credit
// moves to discountApplied and an "internal" discount_applied_penalty row says so, in the same transaction.
// Whatever neither can cover stays on the penalty as unpaid.
// Returns { applied (from the deposit), fromCredit, ... }.
// ─────────────────────────────────────────────
//   { creditOnly: true } skips the deposit and draws from the credit alone: used when a discount is given while a penalty
//   is unpaid, so a penalty staff chose not to take from the deposit isn't taken from it behind their back.
export const applyPenaltyToDeposit = async (penaltyID, actorUid = null, { creditOnly = false } = {}) => {
  const penRef = db.collection("penalties").doc(penaltyID);
  const first = await penRef.get();
  if (!first.exists || !first.data().paymentID) return { applied: 0, fromCredit: 0 };
  const payRef = db.collection("payments").doc(first.data().paymentID);

  const out = await db.runTransaction(async (tx) => {
    const [penSnap, paySnap] = await Promise.all([tx.get(penRef), tx.get(payRef)]);
    if (!penSnap.exists || !paySnap.exists) return { applied: 0, fromCredit: 0 };
    const pen = penSnap.data();
    const pay = paySnap.data();
    if (pen.status !== "Confirmed") return { applied: 0, fromCredit: 0 };
    const dep = getDepositView(pay);
    if (!dep || dep.status !== "Held" || dep.settlement) return { applied: 0, fromCredit: 0 };   // nothing held to take from

    const owed = Math.max(0, (pen.amount || 0) - (pen.paidAmount || 0));
    const free = Math.max(0, dep.amount - (dep.applied || 0));
    const use = creditOnly ? 0 : round2(Math.min(owed, free));
    const fromCredit = creditDrawFor(pay, round2(owed - use));   // the deposit first, then the held discount credit
    if (!(use > 0) && !(fromCredit > 0)) return { applied: 0, fromCredit: 0 };

    const newPaid = round2((pen.paidAmount || 0) + use + fromCredit);
    tx.update(penRef, { paidAmount: newPaid, updatedAt: timestamp() });
    const payPatch = { updatedAt: timestamp() };
    if (use > 0) {
      payPatch.securityDeposit = dep.amount;
      payPatch.depositSettled = round2((dep.applied || 0) + use);   // running total of the deposit used for penalties
    }
    let entryID = null;
    if (fromCredit > 0) {
      Object.assign(payPatch, applyCreditToPenalty(pay, fromCredit));
      const entryRef = db.collection(ENTRY_COLLECTION).doc();
      entryID = entryRef.id;
      const now = new Date();
      tx.set(entryRef, {
        paymentEntryID: entryRef.id,
        paymentID: first.data().paymentID,
        bookingID: pen.bookingID || pay.bookingID || null,
        userID: pay.userID || pen.userID || null,
        refundReqID: null,
        penaltyID,
        direction: "internal",                       // no cash moved: held discount credit paid a penalty
        phase: DISCOUNT_PHASES.appliedPenalty,
        source: null, method: null,
        amount: fromCredit,
        status: "success",
        referenceNumber: null, sessionID: null, transactionFee: null,
        processedBy: actorUid || null,
        processedAt: now, settledAt: now,
        groupID: null, transactionErrorNote: null,
        createdAt: now, updatedAt: now,
      });
    }
    tx.update(payRef, payPatch);
    return { applied: use, fromCredit, entryID, newPaid, bookingID: pen.bookingID, paymentID: first.data().paymentID, userID: pen.userID };
  });

  if (out.applied > 0) {
    await createTransactionLog({
      bookingID: out.bookingID, paymentID: out.paymentID, userID: out.userID, penaltyID,
      type: "Payment", amount: out.applied, status: "Success",
      paymentMethod: "Deposit", performedBy: actorUid,
      description: "Penalty paid from the held security deposit.",
      logID: `${out.paymentID}_deposit_apply_${penaltyID}_${out.newPaid}`,
    }).catch(() => {});
    createAuditLog?.({
      action: "update", userID: actorUid, bookingID: out.bookingID, paymentID: out.paymentID,
      description: `Deducted \u20b1${out.applied} from the security deposit for penalty ${penaltyID} on booking ${out.bookingID}.`,
    }).catch(() => {});
  }
  if (out.fromCredit > 0) {
    await createTransactionLog({
      bookingID: out.bookingID, paymentID: out.paymentID, userID: out.userID, penaltyID,
      type: "Discount", amount: out.fromCredit, status: "Success",
      performedBy: actorUid,
      description: `Penalty paid from the discount credit held for the customer (the security deposit did not cover it).`,
      logID: `${out.paymentID}_credit_apply_${penaltyID}_${out.newPaid}`,
    }).catch(() => {});
    createAuditLog?.({
      action: "update", userID: actorUid, bookingID: out.bookingID, paymentID: out.paymentID,
      description: `Deducted \u20b1${out.fromCredit} from the held discount credit for penalty ${penaltyID} on booking ${out.bookingID} (the security deposit was not enough).`,
    }).catch(() => {});
  }
  return out;
};

// ─────────────────────────────────────────────
// A discount was just given on a fully paid booking while a penalty is still unpaid: the held credit pays it right away
// (oldest penalty first, up to what each owes). Credit only -- never the deposit (see applyPenaltyToDeposit). What the
// credit can't cover stays unpaid; what is left of the credit stays held and goes back at settlement.
// Never throws: the discount itself is already saved, so a failure here is reported, not rolled back.
// Returns { fromCredit, penalties: [{ penaltyID, amount }] }.
// ─────────────────────────────────────────────
export const applyCreditToUnpaidPenalties = async (bookingID, actorUid = null) => {
  const out = { fromCredit: 0, penalties: [] };
  try {
    const snap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
    const unpaid = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => p.status === "Confirmed" && (p.paidAmount || 0) < (p.amount || 0))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
    for (const p of unpaid) {
      const r = await applyPenaltyToDeposit(p.id, actorUid, { creditOnly: true });
      if (r.fromCredit > 0) { out.fromCredit = round2(out.fromCredit + r.fromCredit); out.penalties.push({ penaltyID: p.id, amount: r.fromCredit }); }
    }
  } catch (err) {
    console.error("[PENALTY] applying discount credit to unpaid penalties failed:", err.message);
  }
  return out;
};

// ─────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────

// A penalty paid from the held deposit has no paymentEntries row (no money moved) and no longer stores a date:
// its paidAt is when the deposit was settled, which is kept on payments.depositSettledAt.
const withDepositPaidAt = async (penalties) => {
  const need = penalties.filter((p) => !p.paidAt && (p.paymentMethod === "Deposit" || p.paymentMethod === "DepositPartial") && p.paymentID);
  if (!need.length) return penalties;
  const ids = [...new Set(need.map((p) => p.paymentID))];
  const settledAt = new Map();
  for (let i = 0; i < ids.length; i += 30) {
    const snap = await db.collection("payments").where("paymentID", "in", ids.slice(i, i + 30)).get();
    snap.docs.forEach((d) => settledAt.set(d.data().paymentID, getDepositView(d.data())?.settlement?.settledAt || null));
  }
  return penalties.map((p) => (need.includes(p) && settledAt.get(p.paymentID) ? { ...p, paidAt: settledAt.get(p.paymentID) } : p));
};

export const listPenaltiesForBooking = async (bookingID) => {
  const snap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
  // paymentMethod / referenceNumber / paidAt come back from the payment entries (and, for a deposit offset, from the
  // deposit settlement): none of them is stored on the penalty.
  const hydrated = await withDepositPaidAt(await hydratePenalties(snap.docs.map((d) => ({ id: d.id, ...d.data() }))));
  return hydrated.map(({ id: _docID, ...rest }) => rest);   // same shape as before: no extra id key
};

// Confirmed penalties that still have an outstanding balance (paidAmount
// < amount) for a given customer. Used by recordShortfallPayment() below.
// The customer-backend's own createBooking guard and profile endpoint
// used to read a cached outstandingPenaltyBalance field mirrored onto the
// user doc from this same query — that field was removed since it could
// drift out of sync, so those two spots now run this same kind of query
// directly against Firestore themselves instead of reading a mirror of it.
export const listUnpaidPenaltiesForUser = async (userID) => {
  const snap = await db.collection("penalties")
    .where("userID", "==", userID)
    .where("status", "==", "Confirmed")
    .get();
  return snap.docs.map((d) => d.data()).filter((p) => (p.paidAmount || 0) < (p.amount || 0));
};

// ─────────────────────────────────────────────
// Void / Waive — the only correction path once a penalty is Confirmed. Both
// notify the customer: they have already seen the original charge by then,
// so a void needs its own "this was reversed" message just as much as a
// waive does — otherwise they're left staring at a stale "you were charged
// ₱X" with no update. The exception is a penalty still UnderReview: the
// customer never saw it, so voiding it (the only option for it) is silent.
// ─────────────────────────────────────────────

export const voidOrWaivePenalty = async (penaltyID, status, statusReason, actorUid) => {
  if (!["Voided", "Waived"].includes(status)) return { error: "status must be Voided or Waived." };
  if (!statusReason?.trim()) return { error: "A reason is required." };

  const ref = db.collection("penalties").doc(penaltyID);
  const snap = await ref.get();
  if (!snap.exists) return { error: "Penalty not found." };
  const penalty = snap.data();
  if (penalty.status === "Voided" || penalty.status === "Waived") {
    return { error: `Penalty is already ${penalty.status}.` };
  }
  // A penalty still UnderReview was never shown to the customer, so there is nothing to forgive: it can only be
  // discarded (Voided), and discarding it tells the customer nothing.
  const underReview = penalty.status === "UnderReview";
  if (underReview && status === "Waived") {
    return { error: "A penalty under review hasn't been charged yet, so it can't be waived. Void it to discard it, or confirm it first." };
  }

  // A penalty already paid (partly or fully, via deposit or otherwise)
  // shouldn't be silently voided — that money needs its own reversal, not
  // a status flip. Refuse and point the caller at that instead.
  if ((penalty.paidAmount || 0) > 0) {
    return { error: "This penalty has already been paid against. Reverse the payment before voiding." };
  }

  await ref.update({
    status,
    statusReason,
    updatedAt: timestamp(),
    ...(underReview ? { discardedFromReview: true } : {}),
  });

  const itemNames = (penalty.lineItems || []).map((i) => i.description).join(", ");
  const verb = status === "Waived" ? "waived" : "voided";

  if (!underReview) {
    await notifyCustomer(
      penalty.userID, penalty.bookingID, status === "Waived" ? "PenaltyWaived" : "PenaltyVoided",
      status === "Waived" ? "A charge on your booking was waived" : "A charge on your booking was removed",
      `The ₱${penalty.amount} charge on your recent booking was ${verb} — ${itemNames}.`,
      penaltyID
    );
  }
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: penalty.bookingID, paymentID: penalty.paymentID,
    description: underReview
      ? `Discarded penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}) before it was confirmed — the customer was never notified: ${itemNames}. Reason: ${statusReason}`
      : `${status} penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}): ${itemNames}. Reason: ${statusReason}`,
  }).catch(() => {});

  return { penaltyID };
};

// ─────────────────────────────────────────────
// Deposit
// ─────────────────────────────────────────────
// There is no "record deposit received" step: the deposit is charged inside the booking's own payment and is
// recorded as Held when that payment settles, so how it was paid is already on that payment's entry row.
// (The old recordDepositReceived / POST /api/penalties/deposit/received path was removed because it could only
// duplicate that.)

export const waiveDeposit = async ({ paymentID, reason, by }) => {
  const payment = await getPaymentDoc(paymentID);
  if (!payment) return { error: "Payment not found." };
  if (!reason?.trim()) return { error: "A reason is required to waive the deposit." };

  // Only a HELD deposit can be waived: waiving a settled / refunded / forfeited one would leave depositSettled,
  // depositSettled and depositReturned contradicting the new status. The reason is not stored on the payment,
  // it lives ONLY in the audit log (with who did it), so the log is written in the same transaction as the status
  // change: the deposit can never be waived without its reason being recorded.
  const logRef = db.collection("auditLogs").doc();
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(payment.ref);
      const current = snap.data() || {};
      const dep = getDepositView(current);
      if (!dep || dep.status !== "Held") {
        throw Object.assign(new Error(`Only a held deposit can be waived (currently: ${dep?.status || "not recorded"}).`), { expected: true });
      }
      if (dep.applied > 0) {
        throw Object.assign(new Error("Part of this deposit was already used to pay penalties. Settle the deposit instead of waiving it."), { expected: true });
      }
      // A held discount credit goes back to the customer WITH the deposit, at settlement. Settlement only runs on a Held
      // deposit, so waiving would leave that credit owed with no way to return it.
      if (getDiscountFigures(current).credit > 0) {
        throw Object.assign(new Error("This booking has a discount credit held for the customer, which is returned together with the deposit. Settle the deposit instead of waiving it."), { expected: true });
      }
      tx.update(payment.ref, {
        securityDeposit: dep.amount,                    // survives dropping the old nested object
        depositStatus: "Waived",
        depositSettledAt: timestamp(),
        deposit: admin.firestore.FieldValue.delete(),   // the old nested object, if this payment still has one
      });
      // Same document shape as createAuditLog() writes.
      tx.set(logRef, {
        auditLogsID: logRef.id,
        action: "update",
        description: `Waived the security deposit on booking ${current.bookingID || paymentID}. Reason: ${reason.trim()}`,
        userID: by || null,
        ...(current.bookingID ? { bookingID: current.bookingID } : {}),
        paymentID,
        createdAt: timestamp(),
      });
    });
  } catch (err) {
    if (err.expected) return { error: err.message };
    throw err;
  }

  return { paymentID };
};

// ─────────────────────────────────────────────
// Settlement — runs when staff hit "Confirm & settle" on a booking.
//
// Deducts every unpaid Confirmed penalty from the held deposit, in
// creation order, auto-splitting a penalty across the remaining deposit
// and an unpaid remainder if the deposit runs out partway through (see
// the design note on this in the conversation — the split is shown
// line-by-line, not silently absorbed). Runs in a transaction so a
// double-submit can't pay out the same deposit twice.
// ─────────────────────────────────────────────
// onlineReturn: true -> the money is going back through PayMongo. The deposit is settled and the return row is saved as
// "pending" (no reference yet) in this same transaction: that is the claim. The caller then makes the PayMongo refund
// for exactly `net` and attaches its id to the row (see settleDeposit), so a retry can never refund twice.
export const settleBooking = async ({ bookingID, actorUid, returnMethod, returnReferenceNumber = "", onlineReturn = false }) => {
  const booking = await getBookingDoc(bookingID);
  if (!booking) return { error: "Booking not found." };
  const payment = await getPaymentByBookingID(bookingID);
  if (!payment) return { error: "This booking has no payment record." };
  const paymentID = payment.data.paymentID || payment.ref.id;

  const penaltiesSnap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
  const allPenalties = penaltiesSnap.docs;

  // A penalty a driver noted that no supervisor has confirmed yet isn't part of the math below, so settling now would
  // hand the whole deposit back and leave the penalty as money the customer owes later. Make it be dealt with first.
  const awaitingReview = allPenalties.filter((d) => d.data().status === "UnderReview").length;
  if (awaitingReview > 0) {
    return { error: `${awaitingReview} penalt${awaitingReview === 1 ? "y is" : "ies are"} still waiting for a supervisor's review. Confirm or discard ${awaitingReview === 1 ? "it" : "them"} on the Penalties page before settling the deposit.` };
  }

  const unpaidConfirmed = allPenalties
    .map((d) => ({ ref: d.ref, data: d.data() }))
    .filter((p) => p.data.status === "Confirmed" && (p.data.paidAmount || 0) < (p.data.amount || 0))
    .sort((a, b) => (a.data.createdAt?.toMillis?.() ?? 0) - (b.data.createdAt?.toMillis?.() ?? 0));

  const result = await db.runTransaction(async (tx) => {
    const paymentRef = db.collection("payments").doc(paymentID);
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw new Error("Payment not found.");
    const payment = paymentSnap.data();
    const deposit = getDepositView(payment);   // same view for the new flat fields and the old nested object

    if (!deposit || deposit.status !== "Held") {
      throw new Error(`Deposit is not in a settleable state (currently: ${deposit?.status || "not recorded"}).`);
    }
    if (deposit.settlement) {
      throw new Error("This booking's deposit has already been settled.");
    }

    let returnEntryID = null;                      // the deposit_return row written below, when deposit money goes back
    const alreadyApplied = deposit.applied || 0;   // already used for penalties when they were confirmed

    // The deposit, the penalties and the discount credit held for the customer, worked out in one place (pure, tested):
    // each penalty is paid from the deposit first, then from the credit. The ONE payout that goes back to the customer
    // is what is left of the deposit PLUS what is left of the credit.
    const credit = getDiscountFigures(payment).credit;
    const plan = planSettlement({
      depositAmount: deposit.amount,
      alreadyApplied,
      penalties: unpaidConfirmed.map((p) => ({ id: p.data.penaltyID || p.ref.id, owed: p.data.amount - (p.data.paidAmount || 0) })),
      credit,
    });
    const coveredPenalties = [];   // [{ penaltyID, amount }] -- what the deposit paid toward each penalty
    const creditCovered = [];      // [{ penaltyID, amount }] -- what the held discount credit paid toward each penalty
    const confirmedPenaltyTotal = plan.confirmedPenaltyTotal;

    unpaidConfirmed.forEach((p, i) => {
      const part = plan.perPenalty[i];
      const penaltyID = p.data.penaltyID || p.ref.id;
      if (part.fromDeposit > 0) coveredPenalties.push({ penaltyID, amount: part.fromDeposit });
      // A deposit offset moves no money, so it has no entry row -- and nothing is stored about it on the penalty
      // either: paidAmount is the only fact. "Deposit" / "DepositPartial" and the date are derived on read
      // (hydratePenalty + the deposit settlement's settledAt).
      tx.update(p.ref, { paidAmount: (p.data.paidAmount || 0) + part.fromDeposit + part.fromCredit, updatedAt: timestamp() });
      if (part.fromCredit > 0) {
        creditCovered.push({ penaltyID, amount: part.fromCredit });
        const creditRef = db.collection(ENTRY_COLLECTION).doc();
        const at = new Date();
        tx.set(creditRef, {
          paymentEntryID: creditRef.id, paymentID, bookingID, userID: payment.userID || null,
          refundReqID: null, penaltyID,
          direction: "internal", phase: DISCOUNT_PHASES.appliedPenalty,   // no cash moved
          source: null, method: null, amount: part.fromCredit, status: "success",
          referenceNumber: null, sessionID: null, transactionFee: null,
          processedBy: actorUid || null, processedAt: at, settledAt: at,
          groupID: null, transactionErrorNote: null, createdAt: at, updatedAt: at,
        });
      }
    });

    const net = plan.net;   // money back (positive), exactly settled (0), or still owed (negative); includes the credit
    const settlementStatus = net > 0 ? "Refunded" : net === 0 ? "Settled" : "OwedByCustomer";

    // Flat fields. depositSettled (used) + depositReturned = the deposit. The result (Refunded / Settled / OwedByCustomer)
    // is derived by getDepositView() and not stored: the shortfall lives on the penalties.
    tx.update(paymentRef, {
      securityDeposit: deposit.amount,
      depositStatus: "Settled",
      depositSettled: alreadyApplied + plan.depositUsed,   // used from the deposit; any shortfall stays on the penalties
      depositReturned: plan.depositReturn,                 // the DEPOSIT's own part of the payout (the credit is on its own field)
      depositSettledAt: timestamp(),
      deposit: admin.firestore.FieldValue.delete(),   // the old nested object, if this payment still has one
      // The held discount credit is closed out in the same transaction: what paid penalties moves to
      // discountApplied, what goes back moves to discountReturned, and the credit is 0.
      ...(credit > 0 ? applySettlement(payment, plan) : {}),
    });

    // Two payouts, written together with the settlement. They are separate on purpose: the deposit and the discount credit
    // are different money, each has its own row, status and (online) PayMongo refund, and a failure of one never
    // hides the other. Same way of returning for both: in store (done now) or through PayMongo (pending until confirmed).
    const methodKey = String(returnMethod || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    const writePayout = (phase, amount) => {
      const entryRef = db.collection(ENTRY_COLLECTION).doc();
      const now = new Date();
      tx.set(entryRef, {
        paymentEntryID: entryRef.id,
        paymentID,
        bookingID,
        userID: payment.userID || null,
        refundReqID: null,
        penaltyID: null,
        direction: "out",
        phase,
        source: onlineReturn ? "online" : "in_person",
        method: onlineReturn ? null : (ENTRY_METHODS.includes(methodKey) ? methodKey : null),
        amount,
        status: onlineReturn ? "pending" : "success",   // online: PayMongo confirms afterwards (webhook)
        referenceNumber: onlineReturn ? null : (String(returnReferenceNumber || "").trim() || null),
        sessionID: null,
        transactionFee: null,
        processedBy: actorUid || null,
        processedAt: now,
        settledAt: onlineReturn ? null : now,
        groupID: null,
        transactionErrorNote: null,
        createdAt: now,
        updatedAt: now,
      });
      return entryRef.id;
    };
    let creditEntryID = null;
    if (plan.depositReturn > 0) returnEntryID = writePayout("deposit_return", plan.depositReturn);
    if (plan.creditReturn > 0) creditEntryID = writePayout(DISCOUNT_PHASES.return, plan.creditReturn);

    const outstandingAfterDeposit = plan.stillOwed; // > 0 only when the deposit AND the credit could not cover the penalties
    return {
      confirmedPenaltyTotal: confirmedPenaltyTotal + alreadyApplied, net, settlementStatus, outstandingAfterDeposit, coveredPenalties, creditCovered,
      userID: payment.userID, returnEntryID, creditEntryID, depositReturn: plan.depositReturn, creditReturn: plan.creditReturn, creditUsed: plan.creditUsed,
    };
  });

  // Logged once the transaction has actually committed — same
  // "log the final state" convention as everywhere else in this app.
  // 1) The money handed back, if any: the deposit and the discount credit are logged separately, like their rows.
  // An online return is logged by the PayMongo webhook once PayMongo confirms it (same logID), not before.
  if (result.depositReturn > 0 && !onlineReturn) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID,
      type: "DepositReturn", amount: result.depositReturn, status: "Success",
      paymentMethod: returnMethod, referenceNumber: returnReferenceNumber, performedBy: actorUid,
      description: "Security deposit returned after settlement.",
      logID: `${paymentID}_deposit_settled`,
    });
  }
  if (result.creditReturn > 0 && !onlineReturn) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID,
      type: "Discount", amount: result.creditReturn, status: "Success",
      paymentMethod: returnMethod, referenceNumber: returnReferenceNumber, performedBy: actorUid,
      description: "Discount credit returned to the customer after settlement.",
      logID: `${paymentID}_discount_returned`,
    });
  }
  // 2) One log per penalty the deposit paid toward, with that penalty's own penaltyID and the amount the deposit
  //    covered -- whether or not money was also handed back. The logID makes a repeat a harmless no-op.
  for (const c of result.coveredPenalties) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID, penaltyID: c.penaltyID,
      type: "Payment", amount: c.amount, status: "Success",
      paymentMethod: "Deposit", performedBy: actorUid,
      description: "Penalty paid from security deposit at settlement.",
      logID: `${paymentID}_deposit_penalty_${c.penaltyID}`,
    });
  }
  // 3) The same for the penalties the held discount credit paid toward.
  for (const c of result.creditCovered) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID, penaltyID: c.penaltyID,
      type: "Discount", amount: c.amount, status: "Success",
      performedBy: actorUid,
      description: "Penalty paid from the held discount credit at settlement (the security deposit did not cover it).",
      logID: `${paymentID}_credit_penalty_${c.penaltyID}`,
    });
  }

  // outstandingPenaltyBalance used to be mirrored onto the user doc here.
  // That field has been removed — createBooking() on the customer side
  // now queries `penalties` directly (userID + status == "Confirmed",
  // summing amount - paidAmount) instead of reading a cached rollup, so
  // there's nothing to write back to the user doc anymore.

  return {
    bookingID, paymentID,
    confirmedPenaltyTotal: result.confirmedPenaltyTotal,
    net: result.net,
    settlementStatus: result.settlementStatus,
    outstandingAfterDeposit: result.outstandingAfterDeposit,
    returnEntryID: result.returnEntryID,   // the deposit_return row (null when no deposit money goes back)
    creditEntryID: result.creditEntryID,   // the discount_return row (null when no credit goes back)
    depositReturn: result.depositReturn,   // the deposit's own payout
    creditReturn: result.creditReturn,     // the discount credit's payout, separate from the deposit's
    creditUsed: result.creditUsed,         // credit that paid penalties the deposit could not
  };
};

// Called once staff record a customer paying off an OwedByCustomer
// balance in store (or online — see customer-backend/routes/penalty.routes.js
// for that path). Marks the still-open penalties as paid in creation
// order, same as the deposit deduction above. No user-doc rollup to
// update anymore — the customer side queries `penalties` live instead.
export const recordShortfallPayment = async ({ userID, amount, method, referenceNumber = "", performedBy, penaltyID = null }) => {
  amount = Number(amount);
  if (!(amount > 0)) return { error: "amount must be greater than 0." };
  // This is the in-person (staff) path. The customer can also pay penalties online -- see the customer backend's
  // penaltyPayment.controller.js; both write the same paymentEntries rows.
  if (!PENALTY_SHORTFALL_METHODS.includes(method)) {
    return { error: `method must be one of: ${PENALTY_SHORTFALL_METHODS.join(", ")}.` };
  }
  // A proper record: anything that isn't cash needs the transfer's reference number (cash may carry
  // an official-receipt number).
  referenceNumber = String(referenceNumber == null ? "" : referenceNumber).trim();
  if (method !== "InStore" && !referenceNumber) {
    return { error: `A reference number is required for ${method} payments.` };
  }
  if (referenceNumber.length > 64) {
    return { error: "The reference number can't be longer than 64 characters." };
  }

  const unpaid = await listUnpaidPenaltiesForUser(userID);

  // Never accept more than what is actually owed. Before this, an amount
  // above the balance was quietly clipped (the extra was just dropped) while
  // the UI still said "Payment recorded" — so staff could think they'd
  // taken more than the system credited. Now it's rejected outright.
  //
  // The limit is the customer's TOTAL unpaid penalties, not just the clicked
  // one: a payment with a penaltyID pays that penalty first and the rest
  // spills onto their other unpaid penalties (below), so anything up to the
  // total can genuinely be applied — and nothing above it can.
  const owedOn = (p) => Math.max(0, (p.amount || 0) - (p.paidAmount || 0));
  const limit = unpaid.reduce((sum, p) => sum + owedOn(p), 0);
  if (limit <= 0) return { error: "This customer has no unpaid penalties." };
  if (penaltyID && !unpaid.some((p) => p.penaltyID === penaltyID)) {
    return { error: "That penalty has nothing left to pay — it's already settled, waived or voided." };
  }
  if (amount > limit) {
    return { error: `Amount can't be more than what the customer owes in penalties (\u20b1${limit}).` };
  }

  // If staff clicked Mark Paid on a specific penalty, that one is paid
  // first; anything left over (never more than the limit above) spills onto
  // the customer's other unpaid penalties oldest-first. Without penaltyID
  // it's oldest-first only.
  const byAge = (a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
  const ordered = [...unpaid].sort(byAge);
  if (penaltyID) {
    const idx = ordered.findIndex((p) => p.penaltyID === penaltyID);
    if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]);
  }

  let remaining = amount;
  const batch = db.batch();
  const touched = [];
  const applications = [];   // [{ penalty, amount }] -- what this payment put toward each penalty
  // One payment can cover several penalties: every row it creates shares this groupID.
  const groupID = db.collection(ENTRY_COLLECTION).doc().id;

  for (const p of ordered) {
    if (remaining <= 0) break;
    const owed = p.amount - (p.paidAmount || 0);
    const apply = Math.min(owed, remaining);
    remaining -= apply;
    touched.push(p);
    applications.push({ penalty: p, amount: apply });
    batch.update(db.collection("penalties").doc(p.penaltyID), {
      paidAmount: (p.paidAmount || 0) + apply,
      updatedAt: timestamp(),
    });
    // How / ref / when it was paid live ONLY on the paymentEntries row (one per penalty covered, same batch):
    // the penalty keeps just paidAmount. Readers get the method, reference and date back through hydratePenalties.
    const entryRef = db.collection(ENTRY_COLLECTION).doc();
    batch.set(entryRef, {
      paymentEntryID: entryRef.id,
      ...buildPenaltyPaymentEntry({
        penalty: { ...p, userID: p.userID || userID }, penaltyID: p.penaltyID,
        amount: apply, method, referenceNumber, processedBy: performedBy, groupID,
      }),
    });
  }
  await batch.commit();

  const stillUnpaid = await listUnpaidPenaltiesForUser(userID);
  const newBalance = stillUnpaid.reduce((sum, p) => sum + (p.amount - (p.paidAmount || 0)), 0);

  // Link the log to the booking/payment of the penalty that was paid so it
  // shows up against the right rental (previously this log had neither).
  const first = touched[0];
  // One log per penalty the payment covered, each with its own penaltyID / bookingID / paymentID and the amount
  // put toward THAT penalty. They share the payment's method and reference number (it was one real payment) --
  // the paymentEntries rows of the same payment share a groupID.
  for (const a of applications) {
    await createTransactionLog({
      bookingID: a.penalty.bookingID || null, paymentID: a.penalty.paymentID || null,
      penaltyID: a.penalty.penaltyID,
      userID, type: "Payment", amount: a.amount, status: "Success",
      paymentMethod: method, referenceNumber, performedBy,
      description: "Outstanding penalty balance paid.",
    });
  }
  createAuditLog?.({
    action: "update", userID: performedBy,
    bookingID: first?.bookingID || null, paymentID: first?.paymentID || null,
    description: `Recorded \u20b1${amount - remaining} penalty payment via ${method}${referenceNumber ? ` (ref ${referenceNumber})` : ""}.`,
  }).catch(() => {});

  return { userID, applied: amount - remaining, remainingBalance: newBalance };
};

// ─────────────────────────────────────────────
// Full listing for the admin Penalties page.
//
// Returns every penalty, newest first, enriched with display fields the
// page's stat cards / table need. Mirrors getAllMaintenance()'s join
// pattern in services/maintenance/maintenance.service.js: fetch the
// related collections once, build lookup maps, spread them onto each
// record. userID/carID are already denormalized on the penalty doc, so
// no lookup through `bookings` is needed for those two — only the
// booking's own date range is fetched via bookingID, for display context.
//
// No counts/summaries are computed here — same as maintenance, the
// frontend derives its stat-card counts by filtering this array
// client-side, so there's only one place that owns "what counts as
// Pending/Settled/Voided/Waived".
// ─────────────────────────────────────────────
export const getAllPenalties = async () => {
  const penaltiesSnap = await db.collection("penalties").orderBy("createdAt", "desc").get();

  // Only read the few records the penalties point at. This used to download the whole bookings / cars / brand /
  // model / user collections on every page load just to look up names, which is what made the page slow.
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const byDocIds = async (collection, ids) => {                       // { docID: data }
    const out = {};
    for (let i = 0; i < ids.length; i += 100) {
      const refs = ids.slice(i, i + 100).map((id) => db.collection(collection).doc(String(id)));
      (await db.getAll(...refs)).forEach((d) => { if (d.exists) out[d.id] = d.data(); });
    }
    return out;
  };
  const penaltyDocs = penaltiesSnap.docs.map((d) => d.data());
  const bookingIDs  = uniq(penaltyDocs.map((p) => p.bookingID));
  const [carMap, userMap, creatorMap, bookingByDocId, bookingsByField] = await Promise.all([
    byDocIds("cars", uniq(penaltyDocs.map((p) => p.carID))),
    byDocIds("user", uniq(penaltyDocs.map((p) => p.userID))),
    byDocIds("user", uniq(penaltyDocs.map((p) => p.createdBy))),        // who noted it (a driver, for ones under review)
    byDocIds("bookings", bookingIDs),                                  // bookings keyed by their document id
    (async () => {                                                     // bookings keyed by a bookingID field
      const out = {};
      for (let i = 0; i < bookingIDs.length; i += 10) {
        const snap = await db.collection("bookings").where("bookingID", "in", bookingIDs.slice(i, i + 10)).get();
        snap.docs.forEach((d) => { out[d.data().bookingID || d.id] = d.data(); });
      }
      return out;
    })(),
  ]);
  const bookingMap = { ...bookingByDocId, ...bookingsByField };
  const [brandMap, modelMap] = await Promise.all([
    byDocIds("brand", uniq(Object.values(carMap).map((c) => c.brandID))).then((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.brandName]))),
    byDocIds("model", uniq(Object.values(carMap).map((c) => c.modelID))).then((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.modelName]))),
  ]);

  const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v ?? null);

  // Voided/Waived are checked first and returned as their own distinct
  // status — they never read as "Pending", since paidAmount is always 0
  // on those (voidOrWaivePenalty refuses to void/waive anything already
  // paid against) and a red/amber "money's still due" badge on a charge
  // that was cancelled or forgiven would be actively misleading. For
  // anything still Confirmed, it's paid vs amount: Pending (nothing paid
  // yet), Partially Paid, or Paid (fully covered, via deposit or
  // recordShortfallPayment).
  const settlementStatusFor = (data) => {
    if (data.status === "UnderReview") return "Under Review";   // not charged yet: nothing is owed or paid
    if (data.status === "Voided") return "Voided";
    if (data.status === "Waived") return "Waived";
    const paid = data.paidAmount || 0;
    const amount = data.amount || 0;
    if (paid <= 0) return "Pending";
    if (paid < amount) return "Partially Paid";
    return "Paid";
  };

  // Read through paymentEntries so paymentMethod / referenceNumber / paidAt survive the PHASE 2 cleanup.
  const hydrated = await withDepositPaidAt(await hydratePenalties(penaltiesSnap.docs.map((d) => ({ id: d.id, ...d.data() }))));

  return penaltiesSnap.docs.map((d, idx) => {
    const { id: _docID, ...data } = hydrated[idx];
    const booking = bookingMap[data.bookingID];
    const car = carMap[data.carID];
    const customer = userMap[data.userID];
    const creator = creatorMap[data.createdBy];

    return {
      id: d.id,
      ...data,
      settlementStatus: settlementStatusFor(data),
      customerName: customer?.username || "—",
      createdByName: creator?.username || creator?.name || null,
      plateNumber:  car?.plateNumber   || "—",
      brandName:    car ? brandMap[car.brandID] || "—" : "—",
      modelName:    car ? modelMap[car.modelID] || "—" : "—",
      bookingStart: booking ? toISO(booking.startDateTime) : null,
      bookingEnd:   booking ? toISO(booking.endDateTime)   : null,
      createdAt:    toISO(data.createdAt),
      // Not stored on a penalty confirmed on creation (confirmed when created); a penalty under review isn't confirmed yet.
      confirmedAt:  data.status === "UnderReview" ? null : toISO(data.confirmedAt ?? data.createdAt),
      editedAt:     toISO(data.editedAt),
      paidAt:       toISO(data.paidAt),
      updatedAt:    toISO(data.updatedAt),
    };
  });
};