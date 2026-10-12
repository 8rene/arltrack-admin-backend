// paymentHelpers -- small pure helpers for payments, merged from depositView.js + revenue.util.js.
// Nothing in this file imports another module (revenue's loadLiveBookingKeys takes `db` as an argument),
// so it can still be loaded by scripts and tests without opening a Firebase connection.
//
// Sections:  1. Security deposit shape (getDepositView)   2. What counts as revenue

// ============================================================================
// 1. SECURITY DEPOSIT (was depositView.js)
// ============================================================================
// One place that knows how a payment stores its security deposit.
//
// NEW (flat) shape on payments/{paymentID}:
//   securityDeposit      the deposit amount charged with the first payment (already existed)
//   depositStatus        "Held" | "Waived" | "Settled" | "Forfeited" | "Refunded"
//   depositSettled       pesos of the deposit USED to pay penalties (Settled only). Never more than the deposit:
//                        penalties beyond it stay on the penalties (amount - paidAmount), with their reasons.
//   depositReturned      pesos handed back to the customer (Settled only); no paymentEntries row is written for it
//   depositSettledAt     when the deposit stopped being Held (settled, waived, forfeited or refunded)
// Used + returned = the deposit, so nothing else is stored. The result (Refunded / Settled / OwedByCustomer) is
// derived and is NOT saved: "OwedByCustomer" is live (it clears when the customer pays the shortfall), so it needs
// the unpaid Confirmed penalty total, passed in as getDepositView(payment, { unpaid }). How the deposit was returned
// (method, reference), who settled it and when are on the DepositReturn transaction log; why a waive happened is the
// audit log.
//
// OLD (nested) shape, still read until scripts/migrate-deposit-flat.js has run:
//   payments.deposit = { amount, status, waivedReason, received, returned, settlement }
//
// getDepositView() returns the same shape for both, so no reader needs to know which one it is looking at.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = (v) => v !== undefined && v !== null && v !== "";

export const DEPOSIT_STATUSES = ["Held", "Waived", "Settled", "Forfeited", "Refunded"];

/** Settlement result for a net amount (deposit - penalties): money back, exact, or still owed. */
export const settlementStatusFor = (net) => (net > 0 ? "Refunded" : net === 0 ? "Settled" : "OwedByCustomer");

const fromFlat = (p, opts) => {
  const status = String(p.depositStatus);
  const amount = num(p.securityDeposit) || num(p.depositFee);   // a waived deposit keeps its amount, as before
  const settled = status === "Settled";
  const used = settled ? Math.min(amount, num(p.depositSettled)) : 0;
  const returned = settled ? num(p.depositReturned) : 0;
  const unpaid = num(opts && opts.unpaid);   // unpaid Confirmed penalties right now (the live shortfall)
  let settlement = null;
  if (settled) {
    // Money back -> positive. Nothing back: negative while a penalty is still unpaid, else exactly settled.
    const net = returned > 0 ? returned : (unpaid > 0 ? -unpaid : 0);
    settlement = {
      status: settlementStatusFor(net), net, confirmedPenaltyTotal: used,
      settledBy: null, settledAt: p.depositSettledAt ?? null,
    };
  } else if (status === "Waived") {
    settlement = {
      status: "Waived", net: 0, confirmedPenaltyTotal: 0,
      settledBy: null, settledAt: p.depositSettledAt ?? null,
    };
  }
  return {
    shape: "flat",
    amount,
    status,
    waivedReason: "",
    penaltyTotal: used,
    settlement,
    settled: !!settlement,
    net: settlement ? settlement.net : null,
    deducted: used,                  // penalties actually taken from the deposit
    returnedAmount: returned,
    settledAt: p.depositSettledAt ?? null,
  };
};

const fromNested = (d) => {
  const s = d.settlement && d.settlement.status ? d.settlement : null;
  const amount = num(d.amount);
  const net = s ? num(s.net) : null;
  return {
    shape: "nested",
    amount,
    status: d.status || "",
    waivedReason: d.waivedReason || "",
    penaltyTotal: s ? num(s.confirmedPenaltyTotal) : 0,
    settlement: s,
    settled: !!s,
    net,
    deducted: s ? amount - Math.max(0, net) : 0,
    returnedAmount: num(d.returned && d.returned.amount),
    settledAt: s ? (s.settledAt ?? null) : null,
  };
};

/** The payment's security deposit, or null if none was ever recorded. opts.unpaid = unpaid Confirmed penalties now. */
export const getDepositView = (payment, opts = {}) => {
  const p = payment || {};
  if (has(p.depositStatus)) return fromFlat(p, opts);
  if (p.deposit && typeof p.deposit === "object") return fromNested(p.deposit);
  return null;
};

// ============================================================================
// 2. REVENUE (was revenue.util.js)
// ============================================================================
// What counts as revenue, in ONE place (the dashboard and the analytics charts used to disagree).
//   "approved" -> manually verified payments (bank transfer / cash proof approved by staff)
//   "paid"     -> automated PayMongo payments (GCash, Maya, QRPH) confirmed via webhook
// A payment also only counts while its booking still exists: a live payment whose booking is gone is an orphan
// (data left behind by a hard delete) and must not inflate the totals.
export const REVENUE_STATUSES = ["approved", "paid"];

export const isRevenueStatus = (status) => REVENUE_STATUSES.includes(String(status ?? "").trim().toLowerCase());

/** Set of every live booking key (the bookingID field, falling back to the doc id). Reads one field only. */
export const loadLiveBookingKeys = async (db) => {
  const snap = await db.collection("bookings").select("bookingID").get();
  const keys = new Set();
  snap.forEach((d) => { keys.add(d.id); const k = d.data().bookingID; if (k) keys.add(k); });
  return keys;
};

export const countsAsRevenue = (payment, liveBookingKeys) =>
  isRevenueStatus(payment.status) && liveBookingKeys.has(payment.bookingID);