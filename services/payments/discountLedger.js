// ─────────────────────────────────────────────────────────────────────────────
// Staff discounts — SINGLE SOURCE OF TRUTH for how a discount moves (admin backend).
// Pure functions only (no Firestore, no imports), so they are trivially testable and can be copied to the
// customer backend unchanged, the same way depositView.js / paymentBreakdown.js are.
//
// THE MODEL
// A discount is money the customer does not have to pay. When it is given there are two cases:
//
//   • the payment is still PARTIAL  -> it comes off the remaining balance. Nothing was paid yet, so nothing is owed
//                                      back:                          discountAppliedBalance  += amount
//   • the payment is FULLY PAID     -> the customer has already paid it, so it is HELD for them and returned with
//                                      the security deposit when the trip is settled:   discountCredit += amount
//
// The held credit then moves on in one of two ways:
//   • a penalty the deposit cannot cover is paid from it:  discountCredit -= x, discountAppliedPenalty += x
//   • at settlement what is left goes back to the customer: discountCredit -> 0, discountReturned += credit
//
// Fields on payments/{paymentID} (all written together, in the same batch as the ledger row they describe):
//   discountAmount          total discount given, across every discount given on this booking (a running total)
//   discountAppliedBalance  the part that came off the remaining balance
//   discountAppliedPenalty  the part of the held credit that covered penalties
//   discountCredit          the part still held for the customer (the only one that drains)
//   discountReturned        the part that went back to the customer
//   → discountAmount === discountAppliedBalance + discountAppliedPenalty + discountCredit + discountReturned
//
// A payment WITHOUT discountAppliedBalance is a "legacy" discount (given before this model, refunded on the spot):
// it keeps its old behaviour everywhere and cannot be added to.
//
// Ledger rows live in paymentEntries as direction "internal" (see models/paymentEntries/paymentEntry.model.js):
//   discount_applied_balance · discount_credit · discount_applied_penalty · discount_return
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(num(n) * 100) / 100;
const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();

export const DISCOUNT_PHASES = Object.freeze({
  credit: "discount_credit",
  appliedBalance: "discount_applied_balance",
  appliedPenalty: "discount_applied_penalty",
  return: "discount_return",
});
export const DISCOUNT_ROW_PHASES = Object.freeze(Object.values(DISCOUNT_PHASES));

/** True once a payment carries the new fields (every new-style discount writes all four together). */
export const hasDiscountLedger = (p) => !!p && p.discountAppliedBalance !== undefined && p.discountAppliedBalance !== null;

/** True for a discount given before the ledger existed: refunded on the spot, never added to. */
export const hasLegacyDiscount = (p) => !!p && num(p.discountAmount) > 0 && !hasDiscountLedger(p);

/** The discount's figures. Legacy / no discount: only `total` is meaningful. */
export const getDiscountFigures = (p) => {
  const total = round2(p && p.discountAmount);
  if (!hasDiscountLedger(p)) return { ledger: false, total, appliedBalance: 0, appliedPenalty: 0, credit: 0, returned: 0 };
  return {
    ledger: true,
    total,
    appliedBalance: round2(p.discountAppliedBalance),
    appliedPenalty: round2(p.discountAppliedPenalty),
    credit: round2(p.discountCredit),
    returned: round2(p.discountReturned),
  };
};

/** The identity every ledger discount must satisfy. */
export const figuresBalance = (f) =>
  !f.ledger || Math.abs(f.total - (f.appliedBalance + f.appliedPenalty + f.credit + f.returned)) < 0.005;

/**
 * Where the discount stands, for staff. Derived from the figures, never stored.
 *   none            no discount
 *   legacy          given before the ledger (refunded on the spot): see deriveDiscountRefund
 *   applied         fully used (on the balance and / or penalties): nothing is owed back
 *   held            credit is held for the customer, nothing returned yet
 *   partly_returned some credit went back, some is still held
 *   returned        every peso of credit went back
 */
export const discountStatusOf = (f) => {
  if (!(f.total > 0)) return "none";
  if (!f.ledger) return "legacy";
  if (f.credit > 0 && f.returned > 0) return "partly_returned";
  if (f.credit > 0) return "held";
  if (f.returned > 0) return "returned";
  return "applied";
};

// ── giving a discount ───────────────────────────────────────────────────────────────────────────────────────

/**
 * How much more discount could be given right now, and where it would go. Pure.
 *   totalFee      the booking's grand total
 *   grossPaid     what the customer has paid in total, BEFORE any discount
 *   balance       what is still owed after the discounts already given
 *   given         total of the discounts already given (0 for the first)
 *   depositStatus the security deposit's status ("Held" | "Settled" | ... | null when none was recorded)
 *   legacy        a discount given under the old rules is on the payment
 * Returns { kind: "balance" | "credit", max, blocked } -- `blocked` is the reason no discount can be given, or null.
 */
export const discountRoom = ({ totalFee, grossPaid, balance, given = 0, depositStatus = null, legacy = false }) => {
  const bal = Math.max(0, round2(balance));
  const kind = bal > 0 ? "balance" : "credit";
  const max = kind === "balance"
    ? bal
    : Math.max(0, round2(Math.min(num(totalFee), num(grossPaid)) - num(given)));
  let blocked = null;
  if (legacy) blocked = "A discount was already given on this booking under the old rules, so it can't be changed or added to.";
  else if (lower(depositStatus) === "settled") blocked = "The security deposit has already been settled, so a discount can't be given any more.";
  else if (kind === "credit" && lower(depositStatus) !== "held") blocked = "This booking is fully paid and has no held security deposit to return the discount with, so a discount can't be given.";
  else if (!(max > 0)) blocked = "No more discount can be given on this booking: the discounts already given add up to everything the customer paid.";
  return { kind, max: blocked ? 0 : max, blocked };
};

/**
 * Can this discount be given, and where does it go?  Pure.  Same inputs as discountRoom, plus `amount`.
 * Returns { ok: true, kind, max } or { ok: false, error, max }.
 */
export const planNewDiscount = ({ amount, ...room }) => {
  const a = round2(amount);
  const peso = (n) => `₱${round2(n).toLocaleString()}`;
  const r = discountRoom(room);
  if (r.blocked) return { ok: false, max: 0, error: r.blocked };
  if (!Number.isFinite(Number(amount)) || !(a > 0)) return { ok: false, max: r.max, error: "Enter a discount greater than ₱0." };
  if (a > r.max) {
    return {
      ok: false, max: r.max,
      error: r.kind === "balance"
        ? `A discount on a partial payment can't be more than the remaining balance of ${peso(r.max)}.`
        : `The discount can't be more than ${peso(r.max)} (all the discounts together can't go past what the customer paid).`,
    };
  }
  return { ok: true, kind: r.kind, max: r.max };
};

/** The figures after a new discount of `amount` has been given as `kind`. */
export const applyNewDiscount = (p, kind, amount) => {
  const f = getDiscountFigures(p);
  const a = round2(amount);
  return {
    discountAmount: round2(f.total + a),
    discountAppliedBalance: round2(f.appliedBalance + (kind === "balance" ? a : 0)),
    discountAppliedPenalty: f.appliedPenalty,
    discountCredit: round2(f.credit + (kind === "credit" ? a : 0)),
    discountReturned: f.returned,
  };
};

// ── a penalty drawing from the held credit ──────────────────────────────────────────────────────────────────

/** How much of `owed` the held credit can pay. */
export const creditDrawFor = (p, owed) => Math.max(0, round2(Math.min(num(owed), getDiscountFigures(p).credit)));

/** The figures after `amount` of the held credit paid a penalty. */
export const applyCreditToPenalty = (p, amount) => {
  const f = getDiscountFigures(p);
  const a = Math.min(round2(amount), f.credit);
  return {
    discountAmount: f.total,
    discountAppliedBalance: f.appliedBalance,
    discountAppliedPenalty: round2(f.appliedPenalty + a),
    discountCredit: round2(f.credit - a),
    discountReturned: f.returned,
  };
};

// ── settlement ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What settling the booking does with the deposit, the penalties and the held credit. Pure.
 *   depositAmount   the security deposit
 *   alreadyApplied  the part of it already used when penalties were confirmed
 *   penalties       the unpaid confirmed penalties, oldest first: [{ id, owed }]
 *   credit          the discount credit still held
 * Each penalty is paid from the deposit first, then from the credit; whatever is left stays owed.
 *   → { perPenalty: [{ id, owed, fromDeposit, fromCredit, stillOwed }],
 *       depositUsed, creditUsed, depositNet, depositReturn, creditReturn, payout, stillOwed, net, confirmedPenaltyTotal }
 *   payout = depositReturn + creditReturn: the ONE amount that goes back to the customer.
 *   net    = payout − stillOwed (negative = the customer still owes money).
 */
export const planSettlement = ({ depositAmount, alreadyApplied = 0, penalties = [], credit = 0 }) => {
  let depositLeft = round2(num(depositAmount) - num(alreadyApplied));
  let creditLeft = round2(Math.max(0, num(credit)));
  const perPenalty = [];
  let confirmedPenaltyTotal = 0;
  let depositUsed = 0;
  let creditUsed = 0;
  for (const p of penalties) {
    const owed = round2(p.owed);
    confirmedPenaltyTotal = round2(confirmedPenaltyTotal + owed);
    const fromDeposit = round2(Math.max(0, Math.min(depositLeft, owed)));
    depositLeft = round2(depositLeft - fromDeposit);
    const fromCredit = round2(Math.max(0, Math.min(creditLeft, owed - fromDeposit)));
    creditLeft = round2(creditLeft - fromCredit);
    depositUsed = round2(depositUsed + fromDeposit);
    creditUsed = round2(creditUsed + fromCredit);
    perPenalty.push({ id: p.id, owed, fromDeposit, fromCredit, stillOwed: round2(owed - fromDeposit - fromCredit) });
  }
  const depositNet = round2(num(depositAmount) - num(alreadyApplied) - confirmedPenaltyTotal);   // can be negative
  const depositReturn = Math.max(0, depositNet);
  const creditReturn = creditLeft;
  const stillOwed = round2(perPenalty.reduce((s, x) => s + x.stillOwed, 0));
  const payout = round2(depositReturn + creditReturn);
  return {
    perPenalty, depositUsed, creditUsed, depositNet, depositReturn, creditReturn, payout, stillOwed,
    net: round2(payout - stillOwed), confirmedPenaltyTotal,
  };
};

/** The figures after settlement: the credit that went back moves from `credit` to `returned`, the rest was used on penalties. */
export const applySettlement = (p, plan) => {
  const f = getDiscountFigures(p);
  return {
    discountAmount: f.total,
    discountAppliedBalance: f.appliedBalance,
    discountAppliedPenalty: round2(f.appliedPenalty + plan.creditUsed),
    discountCredit: 0,
    discountReturned: round2(f.returned + plan.creditReturn),
  };
};

// ── reading the ledger rows ─────────────────────────────────────────────────────────────────────────────────

const millis = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.getTime() : 0;
};
const iso = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.toISOString() : null;
};
const isDiscountRow = (e) => !!e && e.direction === "internal" && DISCOUNT_ROW_PHASES.includes(e.phase) && lower(e.status) === "success";

/** The discount's history, oldest first: one item per ledger row. */
export const listDiscountEvents = (entries = []) =>
  (entries || []).filter(isDiscountRow)
    .sort((a, b) => millis(a.createdAt || a.processedAt) - millis(b.createdAt || b.processedAt) || String(a.id || a.paymentEntryID).localeCompare(String(b.id || b.paymentEntryID)))
    .map((e) => ({
      id: e.id || e.paymentEntryID,
      kind: e.phase === DISCOUNT_PHASES.appliedBalance ? "balance"
          : e.phase === DISCOUNT_PHASES.credit ? "credit"
          : e.phase === DISCOUNT_PHASES.appliedPenalty ? "penalty" : "return",
      phase: e.phase,
      amount: round2(e.amount),
      penaltyID: e.penaltyID || null,
      by: e.processedBy || null,
      at: iso(e.processedAt || e.createdAt),
    }));

/**
 * Where the credit's payout stands. The cash moves in the booking's deposit_return row (one payout), so its newest
 * row decides — a retry or an in-store hand-back writes a newer one that supersedes a failed one.
 *   null | { state: "processing" | "returned" | "failed", amount, via, referenceNumber, errorNote, at }
 */
export const deriveCreditReturn = (entries = []) => {
  const rows = (entries || []).filter((e) => e && e.direction === "internal" && e.phase === DISCOUNT_PHASES.return);
  if (!rows.length) return null;
  const amount = round2(rows.reduce((s, r) => s + num(r.amount), 0));
  const payouts = (entries || []).filter((e) => e && e.direction === "out" && e.phase === "deposit_return")
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt));
  const latest = payouts[0] || null;
  if (!latest) return { state: "returned", amount, via: null, referenceNumber: null, errorNote: null, at: iso(rows[rows.length - 1].processedAt) };
  const st = lower(latest.status);
  return {
    state: st === "success" ? "returned" : st === "failed" ? "failed" : "processing",
    amount,
    via: latest.source === "online" ? "paymongo" : "in_store",
    referenceNumber: latest.referenceNumber || null,
    errorNote: latest.transactionErrorNote || null,
    at: iso(latest.settledAt || latest.processedAt || latest.createdAt),
  };
};

/** The figures rebuilt from the ledger rows alone — used to prove the stored fields have not drifted. */
export const rebuildFiguresFromEntries = (entries = []) => {
  const rows = (entries || []).filter(isDiscountRow);
  const sum = (phase) => round2(rows.filter((r) => r.phase === phase).reduce((s, r) => s + num(r.amount), 0));
  const creditGiven = sum(DISCOUNT_PHASES.credit);
  const appliedBalance = sum(DISCOUNT_PHASES.appliedBalance);
  const appliedPenalty = sum(DISCOUNT_PHASES.appliedPenalty);
  const returned = sum(DISCOUNT_PHASES.return);
  return {
    total: round2(appliedBalance + creditGiven),
    appliedBalance, appliedPenalty, returned,
    credit: round2(creditGiven - appliedPenalty - returned),
  };
};

/** { ok, problems[] } — the stored figures must add up AND match the rows. Legacy / no-discount payments are always ok. */
export const checkDiscountLedger = (p, entries = []) => {
  const f = getDiscountFigures(p);
  if (!f.ledger) return { ok: true, problems: [] };
  const problems = [];
  if (!figuresBalance(f)) problems.push("The discount's parts don't add up to the total given.");
  const r = rebuildFiguresFromEntries(entries);
  const same = (k, label) => { if (Math.abs(f[k] - r[k]) >= 0.005) problems.push(`${label} is ₱${f[k]} on the payment but ₱${r[k]} on the ledger rows.`); };
  same("total", "The total discount");
  same("appliedBalance", "The part taken off the balance");
  same("appliedPenalty", "The part used on penalties");
  same("credit", "The held credit");
  same("returned", "The part returned");
  return { ok: problems.length === 0, problems };
};

/**
 * Everything the screens need about a payment's discount, in one object. `entries` = the payment's paymentEntries rows.
 *   { total, appliedBalance, appliedPenalty, credit, returned, status, ledger, creditReturn, events[], consistent, problems[] }
 * null when no discount was ever given.
 */
export const getDiscountView = (p, entries = []) => {
  const f = getDiscountFigures(p);
  if (!(f.total > 0)) return null;
  const check = checkDiscountLedger(p, entries);
  return {
    ...f,
    status: discountStatusOf(f),
    creditReturn: f.ledger ? deriveCreditReturn(entries) : null,
    events: f.ledger ? listDiscountEvents(entries) : [],
    consistent: check.ok,
    problems: check.problems,
  };
};
