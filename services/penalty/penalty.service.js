import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
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
// its own droppedOffTime — used to pre-fill the "+" button in the
// Penalties page (and the driver's own "create penalty" action) before a
// draft is created.
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
  const actualReturnAt = session?.data?.droppedOffTime || booking.data.returnedAt;

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

// Deterministic ID for the one kind of penalty that should only ever
// exist once per booking (the late fee) so a double-click on "+" can't
// create a duplicate draft. Everything else — including damaged parts,
// now that they're named manually in `lineItems` instead of via a
// carPartID FK — gets a random ID, since there's no natural key left to
// dedupe on. There's no `type` field anymore to check against "Late", so
// this keys off lateMinutes being present instead (it's null for every
// non-late-fee penalty — see the model).
const buildPenaltyID = (bookingID, lateMinutes) => {
  if (lateMinutes !== null && lateMinutes !== undefined) return `${bookingID}_late`;
  return null; // caller falls back to db.collection("penalties").doc().id
};

export const createDraftPenalty = async ({
  bookingID, lineItems = [],
  lateMinutes = null, graceMinutes = null, rateAtCreation = null,
  computedAmount = 0, amount, overrideReason = "", createdBy,
}) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { error: "At least one line item is required." };
  }
  if (lineItems.some((item) => !item?.description?.trim())) {
    return { error: "Every line item needs a description." };
  }

  const booking = await getBookingDoc(bookingID);
  if (!booking) return { error: "Booking not found." };

  const payment = await getPaymentByBookingID(bookingID);
  if (!payment) return { error: "No payment record found for this booking." };

  const finalAmount = amount ?? computedAmount;
  if (finalAmount !== computedAmount && !overrideReason.trim()) {
    return { error: "A reason is required when the amount is adjusted from the computed value." };
  }

  const deterministicID = buildPenaltyID(bookingID, lateMinutes);
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
    lineItems,
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
    description: `Drafted penalty of \u20b1${finalAmount} on booking ${bookingID}: ${lineItems.map((i) => i.description).join(", ")}.`,
  }).catch(() => {});

  // Late-fee penalties are system-computed (lateMinutes is set), not a
  // human judgment call the way a damage/cleaning charge is — nothing for
  // a supervisor to review, so skip the Draft queue and confirm right
  // away. This deducts from the deposit and notifies the customer
  // immediately. Manually-typed penalties (lateMinutes null) stay Draft,
  // waiting on a supervisor, same as before.
  if (lateMinutes !== null && lateMinutes !== undefined) {
    const confirmResult = await confirmPenalty(ref.id, createdBy);
    if (confirmResult.error) {
      // Draft already exists and is valid — surface the confirm failure
      // but don't roll back the draft; staff can confirm it manually.
      console.error(`[PENALTY] auto-confirm of late fee ${ref.id} failed:`, confirmResult.error);
      return { penaltyID: ref.id, autoConfirmError: confirmResult.error };
    }
    return { penaltyID: ref.id, autoConfirmed: true };
  }

  return { penaltyID: ref.id };
};

// Only Draft penalties can be edited — once Confirmed, use
// voidOrWaivePenalty + a new draft instead of mutating history.
export const updateDraftPenalty = async (penaltyID, { amount, overrideReason, lineItems }, actorUid) => {
  const ref = db.collection("penalties").doc(penaltyID);
  const snap = await ref.get();
  if (!snap.exists) return { error: "Penalty not found." };
  const penalty = snap.data();
  if (penalty.status !== "Draft") return { error: "Only draft penalties can be edited." };

  if (lineItems !== undefined) {
    if (!Array.isArray(lineItems) || lineItems.length === 0) {
      return { error: "At least one line item is required." };
    }
    if (lineItems.some((item) => !item?.description?.trim())) {
      return { error: "Every line item needs a description." };
    }
  }

  const finalAmount = amount ?? penalty.amount;
  if (finalAmount !== penalty.computedAmount && !(overrideReason ?? penalty.overrideReason ?? "").trim()) {
    return { error: "A reason is required when the amount differs from the computed value." };
  }

  await ref.update({
    amount: finalAmount,
    overrideReason: overrideReason ?? penalty.overrideReason ?? "",
    lineItems: lineItems ?? penalty.lineItems,
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

  const itemNames = (penalty.lineItems || []).map((i) => i.description).join(", ");

  await notifyCustomer(
    penalty.userID, penalty.bookingID, "PenaltyConfirmed",
    "A charge was added to your booking",
    `A ₱${penalty.amount} charge was confirmed on your recent booking — ${itemNames}. See your booking details for the breakdown.`
  );
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: penalty.bookingID, paymentID: penalty.paymentID,
    description: `Confirmed penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}): ${itemNames}.`,
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

  const itemNames = (penalty.lineItems || []).map((i) => i.description).join(", ");

  if (status === "Waived") {
    await notifyCustomer(
      penalty.userID, penalty.bookingID, "PenaltyWaived",
      "A charge on your booking was waived",
      `The ₱${penalty.amount} charge on your recent booking was waived — ${itemNames}.`
    );
  }
  createAuditLog?.({
    action: "update", userID: actorUid,
    bookingID: penalty.bookingID, paymentID: penalty.paymentID,
    description: `${status} penalty of \u20b1${penalty.amount} on booking ${penalty.bookingID} (penalty ${penaltyID}): ${itemNames}. Reason: ${statusReason}`,
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
  };
};

// Called once staff record a customer paying off an OwedByCustomer
// balance in store (or online — see customer-backend/routes/penalty.routes.js
// for that path). Marks the still-open penalties as paid in creation
// order, same as the deposit deduction above. No user-doc rollup to
// update anymore — the customer side queries `penalties` live instead.
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

  await createTransactionLog({
    userID, type: "Payment", amount: amount - remaining, status: "Success",
    paymentMethod: method, referenceNumber, performedBy,
    description: "Outstanding penalty balance paid.",
  });

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
// Draft/Unpaid/Settled/Voided".
// ─────────────────────────────────────────────
export const getAllPenalties = async () => {
  const [penaltiesSnap, bookingsSnap, carsSnap, brandSnap, modelSnap, userSnap] = await Promise.all([
    db.collection("penalties").orderBy("createdAt", "desc").get(),
    db.collection("bookings").get(),
    db.collection("cars").get(),
    db.collection("brand").get(),
    db.collection("model").get(),
    db.collection("user").get(),
  ]);

  const bookingMap = Object.fromEntries(bookingsSnap.docs.map((d) => [d.data().bookingID || d.id, d.data()]));
  const carMap     = Object.fromEntries(carsSnap.docs.map((d) => [d.id, d.data()]));
  const brandMap   = Object.fromEntries(brandSnap.docs.map((d) => [d.id, d.data().brandName]));
  const modelMap   = Object.fromEntries(modelSnap.docs.map((d) => [d.id, d.data().modelName]));
  const userMap    = Object.fromEntries(userSnap.docs.map((d) => [d.id, d.data()]));

  const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v ?? null);

  // Only meaningful for Confirmed penalties — that's the only status
  // where paidAmount tracks real money changing hands (Draft has none
  // yet, Voided/Waived are refused once anything's been paid — see
  // voidOrWaivePenalty). Draft/Voided/Waived just pass their own status
  // through unchanged so the badge always shows something sensible.
  const settlementStatusFor = (data) => {
    if (data.status !== "Confirmed") return data.status;
    const paid = data.paidAmount || 0;
    const amount = data.amount || 0;
    if (paid <= 0) return "Unpaid";
    if (paid < amount) return "Partially Paid";
    return "Paid";
  };

  return penaltiesSnap.docs.map((d) => {
    const data = d.data();
    const booking = bookingMap[data.bookingID];
    const car = carMap[data.carID];
    const customer = userMap[data.userID];

    return {
      id: d.id,
      ...data,
      settlementStatus: settlementStatusFor(data),
      customerName: customer?.username || "—",
      plateNumber:  car?.plateNumber   || "—",
      brandName:    car ? brandMap[car.brandID] || "—" : "—",
      modelName:    car ? modelMap[car.modelID] || "—" : "—",
      bookingStart: booking ? toISO(booking.startDateTime) : null,
      bookingEnd:   booking ? toISO(booking.endDateTime)   : null,
      createdAt:    toISO(data.createdAt),
      confirmedAt:  toISO(data.confirmedAt),
      paidAt:       toISO(data.paidAt),
      updatedAt:    toISO(data.updatedAt),
    };
  });
};