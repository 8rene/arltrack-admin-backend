// What is still "in flight" on a booking (or on one payment / penalty), so a delete does not silently bury money.
// Pure: no database, no imports, so the Payments / Penalties / Bookings delete screens and the tests all share it.
//
//   blockers  stop the delete. Owner / Admin can force past them (the records are archived, not destroyed);
//             a Supervisor never can.
//   warnings  are shown in the confirm dialog but never stop anything.
//
// Everything is optional, so the same function serves a whole booking bundle and a lone orphaned payment / penalty.
const low = (v) => String(v ?? "").trim().toLowerCase();
const num = (v) => Number(v) || 0;
const peso = (n) => `\u20b1${num(n).toLocaleString("en-PH")}`;

export const evaluateGuards = ({ booking = null, payments = [], refunds = [], penalties = [] } = {}) => {
  const blockers = [];
  const warnings = [];
  const bookingStatus = low(booking?.status);

  if (bookingStatus === "ongoing") {
    blockers.push({ code: "trip_in_progress", message: "This booking is ongoing (trip in progress)." });
  }

  for (const r of refunds) {
    if (["pending", "approved"].includes(low(r.status))) {
      blockers.push({ code: "refund_open", message: `A refund request (${r.status}, ${peso(r.amount)}) is still open.`, ref: r.refundRequestID || r.id });
    }
  }

  for (const p of payments) {
    // discount spill-over: cash that is owed back to the customer and has not been handed back yet
    if (num(p.refundDue) > 0 && !p.refundIssued) {
      blockers.push({ code: "refund_due", message: `${peso(p.refundDue)} is owed back to the customer and has not been marked as handed back.`, ref: p.paymentID || p.id });
    }
    // the security deposit is still held although the trip is over: the customer is owed it (or it must be settled)
    if (low(p.depositStatus) === "held" && bookingStatus === "completed") {
      blockers.push({ code: "deposit_held", message: `The ${peso(p.securityDeposit)} security deposit is still held — settle or return it first.`, ref: p.paymentID || p.id });
    }
  }

  for (const pn of penalties) {
    if (low(pn.status) === "underreview") {
      blockers.push({ code: "penalty_review", message: "A penalty noted by a driver is still waiting for a supervisor's review — confirm or discard it first.", ref: pn.penaltyID || pn.id });
    }
    if (low(pn.status) === "confirmed" && num(pn.paidAmount) < num(pn.amount)) {
      blockers.push({ code: "penalty_unpaid", message: `A confirmed penalty still has ${peso(num(pn.amount) - num(pn.paidAmount))} unpaid.`, ref: pn.penaltyID || pn.id });
    }
  }

  const paid = payments.filter((p) => ["paid", "approved"].includes(low(p.status)));
  if (booking && paid.length && bookingStatus === "upcoming") {
    warnings.push({ code: "paid_upcoming", message: "This booking is upcoming and already paid: archiving it removes a live reservation." });
  }
  if (booking && paid.length && bookingStatus === "cancelled" && !refunds.length) {
    warnings.push({ code: "paid_cancelled_no_refund", message: "The booking was cancelled, the customer paid, and no refund was ever opened (the money was kept)." });
  }
  if (booking && bookingStatus === "cancelled" && payments.some((p) => low(p.depositStatus) === "held")) {
    warnings.push({ code: "deposit_held_cancelled", message: "The booking was cancelled but a security deposit is still marked as held." });
  }
  return { blockers, warnings };
};

export class DeleteBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DeleteBlockedError";
    this.code = "BLOCKED";
    this.details = details;   // { blockers, warnings, canForce }
  }
}

/** True when the caller may delete past the blockers. */
export const mayForce = ({ force = false, canForce = false } = {}) => Boolean(force && canForce);