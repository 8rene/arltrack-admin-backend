import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  PENALTY_STATUSES,
  createPenaltyPayload,
} from "../../models/penalty/penalty.model.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { createNotification, notifyStaff } from "../notification/notification.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";
import { getSessionByBookingID } from "../booking/bookingSession.service.js";
import { resolveCurrentDriverID } from "../driverAssignments/driverAssignments.service.js";

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const notifyCustomer = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[PENALTY] failed to notify customer (${type}):`, err.message));
};

// Fans out to every Owner/Admin/Supervisor. This is what replaced the old
// Draft review step: nobody signs off on a penalty before the customer
// sees it anymore, so this is how a supervisor finds out a charge went
// out (e.g. one a Driver logged) in time to void/waive it if it's wrong,
// instead of only finding out when they happen to check the Penalties
// page.
const notifyStaffOfPenalty = (bookingID, penaltyID, amount, itemNames) =>
  notifyStaff({
    type: "penalty_created",
    refID: penaltyID,
    refCollection: "penalties",
    title: "A penalty was charged",
    message: `₱${amount} was charged on booking ${bookingID} and the customer was notified — ${itemNames}.`,
  }).catch((err) => console.error("[PENALTY] failed to notify staff:", err.message));

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
  const actualReturnAt = session?.data?.droppedOffTime || booking.data.returnedAt;

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
  };
};

// ─────────────────────────────────────────────
// Creation — every penalty is confirmed and the customer notified
// immediately. There is no Draft step anymore: no supervisor review
// queue sits in front of this. See notifyStaffOfPenalty above for what
// replaced that review — a supervisor is told the moment it happens
// instead of before it happens, and can void/waive it after the fact if
// it's wrong.
// ─────────────────────────────────────────────

// Late fees are no longer a special kind of penalty: staff and drivers type
// every charge by hand (the late-fee preview above is only a suggestion shown
// next to the form). That's why there's no lateMinutes/graceMinutes/rate here
// anymore and no one-per-booking ID — a late charge can be voided and
// charged again like any other line.
export const createPenalty = async ({
  bookingID, lineItems = [],
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

  const ref = db.collection("penalties").doc();

  const now = timestamp();
  const payload = createPenaltyPayload(ref.id, {
    bookingID,
    paymentID: payment.data.paymentID || payment.ref.id,
    userID:    booking.data.userID    || null,
    carID:     booking.data.carID     || null,
    lineItems,
    computedAmount, amount: finalAmount, overrideReason,
    status: "Confirmed",
    createdBy,
    confirmedBy: createdBy,
    createdAt: now,
    confirmedAt: now,
    updatedAt: now,
  });

  await ref.set(payload);

  const itemNames = lineItems.map((i) => i.description).join(", ");

  createAuditLog?.({
    action: "create", userID: createdBy,
    bookingID, paymentID: payload.paymentID,
    description: `Charged penalty of \u20b1${finalAmount} on booking ${bookingID}: ${itemNames}.`,
  }).catch(() => {});

  await notifyCustomer(
    payload.userID, bookingID, "PenaltyConfirmed",
    "A charge was added to your booking",
    `A ₱${finalAmount} charge was added to your recent booking — ${itemNames}. See your booking details for the breakdown.`
  );
  await notifyStaffOfPenalty(bookingID, ref.id, finalAmount, itemNames);

  return { penaltyID: ref.id };
};

// ─────────────────────────────────────────────
// Listing
// ─────────────────────────────────────────────

export const listPenaltiesForBooking = async (bookingID) => {
  const snap = await db.collection("penalties").where("bookingID", "==", bookingID).get();
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
// Void / Waive — the only correction path left now that penalties are
// confirmed on creation. Both notify the customer: with no Draft buffer
// in front of confirmation, the customer has already seen the original
// charge by the time anyone can undo it, so a void needs its own
// "this was reversed" message just as much as a waive does — otherwise
// they're left staring at a stale "you were charged ₱X" with no update.
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
  const verb = status === "Waived" ? "waived" : "voided";

  await notifyCustomer(
    penalty.userID, penalty.bookingID, status === "Waived" ? "PenaltyWaived" : "PenaltyVoided",
    status === "Waived" ? "A charge on your booking was waived" : "A charge on your booking was removed",
    `The ₱${penalty.amount} charge on your recent booking was ${verb} — ${itemNames}.`
  );
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

  // The deposit is now charged with the booking's own payment and recorded
  // as Held automatically when that payment settles — don't double-collect.
  if (["Held", "Settled"].includes(payment.data.deposit?.status)) {
    return { error: "A security deposit is already recorded for this booking." };
  }

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
export const recordShortfallPayment = async ({ userID, amount, method, referenceNumber = "", performedBy, penaltyID = null }) => {
  amount = Number(amount);
  if (!(amount > 0)) return { error: "amount must be greater than 0." };

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

  for (const p of ordered) {
    if (remaining <= 0) break;
    const owed = p.amount - (p.paidAmount || 0);
    const apply = Math.min(owed, remaining);
    remaining -= apply;
    touched.push(p);
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

  // Link the log to the booking/payment of the penalty that was paid so it
  // shows up against the right rental (previously this log had neither).
  const first = touched[0];
  await createTransactionLog({
    bookingID: first?.bookingID || null, paymentID: first?.paymentID || null,
    userID, type: "Payment", amount: amount - remaining, status: "Success",
    paymentMethod: method, referenceNumber, performedBy,
    description: "Outstanding penalty balance paid.",
  });
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

  // Voided/Waived are checked first and returned as their own distinct
  // status — they never read as "Pending", since paidAmount is always 0
  // on those (voidOrWaivePenalty refuses to void/waive anything already
  // paid against) and a red/amber "money's still due" badge on a charge
  // that was cancelled or forgiven would be actively misleading. For
  // anything still Confirmed, it's paid vs amount: Pending (nothing paid
  // yet), Partially Paid, or Paid (fully covered, via deposit or
  // recordShortfallPayment).
  const settlementStatusFor = (data) => {
    if (data.status === "Voided") return "Voided";
    if (data.status === "Waived") return "Waived";
    const paid = data.paidAmount || 0;
    const amount = data.amount || 0;
    if (paid <= 0) return "Pending";
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