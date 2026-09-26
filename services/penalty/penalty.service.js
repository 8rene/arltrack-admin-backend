import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  PENALTY_TYPES,
  PENALTY_STATUSES,
  createPenaltyPayload,
} from "../../models/penalty/penalty.model.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { createNotification } from "../notification/notification.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const notifyCustomer = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[PENALTY] failed to notify customer (${type}):`, err.message));
};

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
// its own returnedAt/customerDroppedOffAt — used to pre-fill the "+"
// button in the Penalties page before a draft is created. Chauffeur
// bookings use customerDroppedOffAt (the driver isn't holding the car
// hostage waiting for a Return click); everything else uses returnedAt.
export const previewLateFeeForBooking = async (bookingID) => {
  const booking = await getBookingDoc(bookingID);
  if (!booking) return null;

  const settings = await getSystemSettings();
  const graceMinutes = Number(settings.lateFeeGraceMinutes ?? 30);
  const ratePerHour   = Number(settings.lateFeeRatePerHour ?? 100);

  // "With Chauffeur" bookings use customerDroppedOffAt — the driver keeps
  // the car after drop-off to return it and do the after-trip inspection,
  // so attributing that transit/inspection time to the customer as
  // lateness would overcharge them. Field name matches booking.service.js
  // / driverDispatch.service.js's modeOfDriving check exactly.
  const isChauffeur = booking.data.modeOfDriving === "With Chauffeur";
  const actualReturnAt = isChauffeur
    ? booking.data.customerDroppedOffAt
    : booking.data.returnedAt;

  const { lateMinutes, billableHours, computedAmount } = computeLateFee({
    scheduledEndAt: booking.data.endDateTime,
    actualReturnAt,
    graceMinutes,
    ratePerHour,
  });

  return { bookingID, lateMinutes, billableHours, graceMinutes, ratePerHour, computedAmount };
};

// ─────────────────────────────────────────────
// Draft creation / editing
// ─────────────────────────────────────────────

// Deterministic ID for types that should only ever exist once per
// booking (late fee, a specific damaged part) so a double-click on "+"
// can't create a duplicate draft. Free-typed "other" penalties get a
// random ID since there's no natural key to dedupe on.
const buildPenaltyID = (bookingID, type, key) => {
  if (type === "Late") return `${bookingID}_late`;
  if (type === "Part" && key) return `${bookingID}_part_${key}`;
  return null; // caller falls back to db.collection("penalties").doc().id
};

export const createDraftPenalty = async ({
  bookingID, type, description = "", carPartID = null, inspectionID = null,
  lateMinutes = null, graceMinutes = null, rateAtCreation = null,
  computedAmount = 0, amount, overrideReason = "", createdBy,
}) => {
  if (!PENALTY_TYPES.includes(type)) {
    return { error: `Invalid penalty type "${type}".` };
  }

  const booking = await getBookingDoc(bookingID);
  if (!booking) return { error: "Booking not found." };

  const payment = await getPaymentByBookingID(bookingID);
  if (!payment) return { error: "No payment record found for this booking." };

  const finalAmount = amount ?? computedAmount;
  if (finalAmount !== computedAmount && !overrideReason.trim()) {
    return { error: "A reason is required when the amount is adjusted from the computed value." };
  }

  const deterministicID = buildPenaltyID(bookingID, type, carPartID);
  const ref = deterministicID
    ? db.collection("penalties").doc(deterministicID)
    : db.collection("penalties").doc();

  // Deterministic-ID types are one-per-booking by construction — refuse
  // outright rather than silently overwriting an existing draft/confirmed
  // penalty for the same late fee or the same damaged part.
  if (deterministicID) {
    const existing = await ref.get();
    if (existing.exists) {
      return { error: "A penalty for this already exists on this booking.", penaltyID: ref.id };
    }
  }

  const payload = createPenaltyPayload(ref.id, {
    bookingID,
    paymentID: payment.data.paymentID || payment.ref.id,
    userID:    booking.data.userID    || null,
    carID:     booking.data.carID     || null,
    type, description, carPartID, inspectionID,
    lateMinutes, graceMinutes, rateAtCreation,
    computedAmount, amount: finalAmount, overrideReason,
    status: "Draft",
    createdBy,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });

  await ref.set(payload);
  createAuditLog?.({
    action: "create", userID: createdBy,
    bookingID, paymentID: payload.paymentID,
    description: `Drafted ${type} penalty of \u20b1${finalAmount} on booking ${bookingID}.`,
  }).catch(() => {});

  return { penaltyID: ref.id };
};

// Only Draft penalties can be edited — once Confirmed, use
// voidOrWaivePenalty + a new draft instead of mutating history.
export const updateDraftPenalty = async (penaltyID, { amount, overrideReason, description }, actorUid) => {
  const ref = db.collection("penalties").doc(penaltyID);
  const snap = await ref.get();
  if (!snap.exists) return { error: "Penalty not found." };
  const penalty = snap.data();
  if (penalty.status !== "Draft") return { error: "Only draft penalties can be edited." };

  const finalAmount = amount ?? penalty.amount;
  if (finalAmount !== penalty.computedAmount && !(overrideReason ?? penalty.overrideReason ?? "").trim()) {
    return { error: "A reason is required when the amount differs from the computed value." };
  }

  await ref.update({
    amount: finalAmount,
    overrideReason: overrideReason ?? penalty.overrideReason ?? "",
    description: description ?? penalty.description,
    updatedAt: timestamp(),
  });
  return { penaltyID };
};

// ─────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────

export const listPenaltiesForBooking = async (bookingID) => {
  const snap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
  return snap.docs.map((d) => d.data());
};

// The staff-facing queue: drafts awaiting confirmation, across all
// bookings, oldest first so nothing sits forgotten.
export const listDraftQueue = async () => {
  const snap = await db.collection("penalties").where("status", "==", "Draft").orderBy("createdAt", "asc").get();
  return snap.docs.map((d) => d.data());
};

// Confirmed penalties that still have an outstanding balance (paidAmount
// < amount) for a given customer — this is what powers the createBooking
// guard on the customer side. See services/user/user.service.js's
// outstandingPenaltyBalance mirror, written by settleBooking() below,
// which is the cheap read the customer backend actually uses; this
// function is the source of truth it's mirrored from.
export const listUnpaidPenaltiesForUser = async (userID) => {
  const snap = await db.collection("penalties")
    .where("userID", "==", userID)
    .where("status", "==", "Confirmed")
    .get();
  return snap.docs.map((d) => d.data()).filter((p) => (p.paidAmount || 0) < (p.amount || 0));
};

// ─────────────────────────────────────────────
// Confirm / Void / Waive
// ─────────────────────────────────────────────

export const confirmPenalty = async (penaltyID, actorUid) => {
  const ref = db.collection("penalties").doc(penaltyID);
  const snap = await ref.get();
  if (!snap.exists) return { error: "Penalty not found." };
  const penalty = snap.data();
  if (penalty.status !== "Draft") return { error: `Penalty is already ${penalty.status}.` };

  await ref.update({
    status: "Confirmed",
    confirmedBy: actorUid,
    confirmedAt: timestamp(),
    updatedAt: timestamp(),
  });

  await notifyCustomer(
    penalty.userID, penalty.bookingID, "PenaltyConfirmed",
    "A charge was added to your booking",
    `A ₱${penalty.amount} charge (${penalty.type}) was confirmed on your recent booking. See your booking details for the breakdown.`
  );
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: penalty.bookingID, paymentID: penalty.paymentID,
    description: `Confirmed ${penalty.type} penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}).`,
  }).catch(() => {});

  return { penaltyID };
};

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
  });

  if (status === "Waived") {
    await notifyCustomer(
      penalty.userID, penalty.bookingID, "PenaltyWaived",
      "A charge on your booking was waived",
      `The ₱${penalty.amount} charge (${penalty.type}) on your recent booking was waived.`
    );
  }
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: penalty.bookingID, paymentID: penalty.paymentID,
    description: `${status} ${penalty.type} penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}). Reason: ${statusReason}`,
  }).catch(() => {});

  return { penaltyID };
};

// ─────────────────────────────────────────────
// Deposit received (at pickup)
// ─────────────────────────────────────────────

export const recordDepositReceived = async ({ paymentID, method, referenceNumber = "", by }) => {
  const payment = await getPaymentDoc(paymentID);
  if (!payment) return { error: "Payment not found." };

  const settings = await getSystemSettings();
  const amount = Number(settings.securityDepositAmount ?? 1000);

  await payment.ref.update({
    deposit: {
      amount,
      status: "Held",
      waivedReason: "",
      received: { method, referenceNumber, by, at: timestamp() },
      returned: { method: null, referenceNumber: "", by: null, at: null, amount: 0 },
      settlement: { confirmedPenaltyTotal: 0, net: 0, status: "", settledBy: null, settledAt: null },
    },
  });

  await createTransactionLog({
    bookingID: payment.data.bookingID, paymentID, userID: payment.data.userID,
    type: "Deposit", amount, status: "Success",
    paymentMethod: method, referenceNumber, performedBy: by,
    description: "Security deposit collected at pickup.",
    logID: `${paymentID}_deposit_received`,
  });

  return { paymentID, amount };
};

export const waiveDeposit = async ({ paymentID, reason, by }) => {
  const payment = await getPaymentDoc(paymentID);
  if (!payment) return { error: "Payment not found." };
  if (!reason?.trim()) return { error: "A reason is required to waive the deposit." };

  await payment.ref.update({
    deposit: {
      amount: 0,
      status: "Waived",
      waivedReason: reason,
      received: { method: null, referenceNumber: "", by, at: timestamp() },
      returned: { method: null, referenceNumber: "", by: null, at: null, amount: 0 },
      settlement: { confirmedPenaltyTotal: 0, net: 0, status: "Waived", settledBy: by, settledAt: timestamp() },
    },
  });

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
export const settleBooking = async ({ bookingID, actorUid, returnMethod, returnReferenceNumber = "" }) => {
  const booking = await getBookingDoc(bookingID);
  if (!booking) return { error: "Booking not found." };
  const payment = await getPaymentByBookingID(bookingID);
  if (!payment) return { error: "This booking has no payment record." };
  const paymentID = payment.data.paymentID || payment.ref.id;

  const penaltiesSnap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
  const allPenalties = penaltiesSnap.docs;
  const draftStillOpen = allPenalties.some((d) => d.data().status === "Draft");
  if (draftStillOpen) {
    return { error: "This booking still has draft penalties. Confirm or void/waive them first." };
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
    const deposit = payment.deposit;

    if (!deposit || deposit.status !== "Held") {
      throw new Error(`Deposit is not in a settleable state (currently: ${deposit?.status || "not recorded"}).`);
    }
    if (deposit.settlement?.status) {
      throw new Error("This booking's deposit has already been settled.");
    }

    let remainingDeposit = deposit.amount;
    let confirmedPenaltyTotal = 0;
    const penaltyUpdates = [];

    for (const p of unpaidConfirmed) {
      const owed = p.data.amount - (p.data.paidAmount || 0);
      confirmedPenaltyTotal += owed;
      const fromDeposit = Math.min(remainingDeposit, owed);
      remainingDeposit -= fromDeposit;
      const newPaidAmount = (p.data.paidAmount || 0) + fromDeposit;
      penaltyUpdates.push({
        ref: p.ref,
        paidAmount: newPaidAmount,
        paymentMethod: fromDeposit === owed ? "Deposit" : (fromDeposit > 0 ? "DepositPartial" : p.data.paymentMethod || ""),
        paidAt: fromDeposit > 0 ? timestamp() : (p.data.paidAt || null),
        stillOwed: owed - fromDeposit,
      });
    }

    const net = deposit.amount - confirmedPenaltyTotal; // can be negative
    const settlementStatus = net > 0 ? "Refunded" : net === 0 ? "Settled" : "OwedByCustomer";

    penaltyUpdates.forEach((u) => {
      tx.update(u.ref, {
        paidAmount: u.paidAmount,
        paymentMethod: u.paymentMethod,
        paidAt: u.paidAt,
        updatedAt: timestamp(),
      });
    });

    tx.update(paymentRef, {
      "deposit.status": "Settled",
      "deposit.returned": {
        method: net > 0 ? returnMethod : null,
        referenceNumber: net > 0 ? returnReferenceNumber : "",
        by: actorUid,
        at: timestamp(),
        amount: Math.max(0, net),
      },
      "deposit.settlement": {
        confirmedPenaltyTotal,
        net,
        status: settlementStatus,
        settledBy: actorUid,
        settledAt: timestamp(),
      },
    });

    const outstandingAfterDeposit = Math.max(0, -net); // > 0 only when net is negative
    return { confirmedPenaltyTotal, net, settlementStatus, outstandingAfterDeposit, userID: payment.userID };
  });

  // Logged once the transaction has actually committed — same
  // "log the final state" convention as everywhere else in this app.
  if (result.net > 0) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID,
      type: "DepositReturn", amount: result.net, status: "Success",
      paymentMethod: returnMethod, referenceNumber: returnReferenceNumber, performedBy: actorUid,
      description: "Security deposit returned after settlement.",
      logID: `${paymentID}_deposit_settled`,
    });
  } else if (result.confirmedPenaltyTotal > 0) {
    await createTransactionLog({
      bookingID, paymentID, userID: result.userID,
      type: "Payment", amount: Math.min(result.confirmedPenaltyTotal, /* covered-by-deposit portion */ result.confirmedPenaltyTotal - result.outstandingAfterDeposit),
      status: "Success", paymentMethod: "Deposit", performedBy: actorUid,
      description: "Penalties deducted from security deposit at settlement.",
      logID: `${paymentID}_deposit_settled`,
    });
  }

  // Mirror the still-outstanding balance onto the user doc so
  // createBooking() on the customer side is a cheap single read instead
  // of scanning that customer's penalties on every booking attempt.
  if (result.userID) {
    await db.collection("user").doc(result.userID).set(
      { outstandingPenaltyBalance: result.outstandingAfterDeposit },
      { merge: true }
    );
  }

  return {
    bookingID, paymentID,
    confirmedPenaltyTotal: result.confirmedPenaltyTotal,
    net: result.net,
    settlementStatus: result.settlementStatus,
    outstandingAfterDeposit: result.outstandingAfterDeposit,
  };
};

// Called once staff record a customer paying off an OwedByCustomer
// balance in store (or online — see customer-backend/routes/penalty.routes.js
// for that path). Reduces the mirrored balance and marks the still-open
// penalties as paid in creation order, same as the deposit deduction above.
export const recordShortfallPayment = async ({ userID, amount, method, referenceNumber = "", performedBy }) => {
  if (!(amount > 0)) return { error: "amount must be greater than 0." };

  const unpaid = await listUnpaidPenaltiesForUser(userID);
  let remaining = amount;
  const batch = db.batch();

  for (const p of unpaid.sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0))) {
    if (remaining <= 0) break;
    const owed = p.amount - (p.paidAmount || 0);
    const apply = Math.min(owed, remaining);
    remaining -= apply;
    batch.update(db.collection("penalties").doc(p.penaltyID), {
      paidAmount: (p.paidAmount || 0) + apply,
      paymentMethod: method,
      referenceNumber,
      paidAt: timestamp(),
      updatedAt: timestamp(),
    });
  }
  await batch.commit();

  const stillUnpaid = await listUnpaidPenaltiesForUser(userID);
  const newBalance = stillUnpaid.reduce((sum, p) => sum + (p.amount - (p.paidAmount || 0)), 0);
  await db.collection("user").doc(userID).set({ outstandingPenaltyBalance: newBalance }, { merge: true });

  await createTransactionLog({
    userID, type: "Payment", amount: amount - remaining, status: "Success",
    paymentMethod: method, referenceNumber, performedBy,
    description: "Outstanding penalty balance paid.",
  });

  return { userID, applied: amount - remaining, remainingBalance: newBalance };
};