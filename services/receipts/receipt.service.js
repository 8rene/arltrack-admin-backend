// Receipts + Booking Statement + the shared email limit.
//
// A hand-ported copy of this logic lives in the customer backend (utils/receipt/receipt.util.js), so a customer and a staff
// member see the same numbers. Change one, change the other.
//
import crypto from "crypto";
import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";

// A RECEIPT is for ONE money movement (a paymentEntries row):
//   kind "payment"         money in, phase deposit | balance                -> "Payment Receipt"
//   kind "penalty"         money in, phase penalty (one line per penalty paid together, via groupID) -> "Penalty Receipt"
//   kind "refund"          money out, a refund of deposit/balance/penalty   -> "Refund Slip"
//   kind "deposit_return"  money out, the security deposit handed back      -> "Security Deposit Return Slip"
// Only a SUCCESSFUL entry gets one: pending / failed / cancelled / unrefundable movements are not receipts.
//
// A BOOKING STATEMENT is ONE overall document for a whole booking: every payment, every penalty, the deposit, refunds,
// what is still pending, and the overall figures -- as of the moment it is built.
//
// Both are generated on demand and nothing about them is stored, so they can never disagree with the money rows.

const ENTRY_COLLECTIONS = ["paymentEntries", "paymentEntryArchives"];   // live first: a live row wins
const PENALTY_COLLECTIONS = ["penalties", "penaltyArchives"];

const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
const toMs = (v) => { const d = v?.toDate ? v.toDate() : v ? new Date(v) : null; return d && !isNaN(d) ? d.getTime() : 0; };
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (rows, f = (r) => r.amount) => round2(rows.reduce((s, r) => s + num(f(r)), 0));
const httpError = (status, message) => Object.assign(new Error(message), { status });

export const KIND_TITLES = {
  payment: "Payment Receipt",
  penalty: "Penalty Receipt",
  refund: "Refund Slip",
  deposit_return: "Security Deposit Return Slip",
};
// The held discount credit paid back to the customer is a "refund" row (it counts as money refunded) but is not a refund of a
// payment, so its slip says what it is.
const titleFor = (e, kind) => (e && e.phase === "discount_return" ? "Discount Credit Return Slip" : KIND_TITLES[kind]);
const KIND_PREFIX = { payment: "RC", penalty: "PN", refund: "RF", deposit_return: "DR" };
const PHASE_LABEL = { deposit: "Deposit", balance: "Balance", penalty: "Penalty", deposit_return: "Security deposit" };

export const kindOf = (e) => {
  if (e.direction === "out") return e.phase === "deposit_return" ? "deposit_return" : "refund";
  return e.phase === "penalty" ? "penalty" : "payment";
};

const ymdManila = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).replace(/-/g, "").slice(2) : "000000";
};

// Same entry always gets the same number: <prefix>-<yyMMdd (Manila time) of the money moving>-<6 hex chars of the id>.
// Penalties paid together share one receipt, so they hash the groupID instead of the individual entry id.
export const receiptNumberFor = (entry, kind, whenISO) => {
  const key = entry.groupID ? `group:${entry.groupID}` : String(entry.id);
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 6).toUpperCase();
  return `${KIND_PREFIX[kind]}-${ymdManila(whenISO)}-${hash}`;
};

// BS-<yyMMdd (Manila) the statement was generated>-<6 hex chars of the bookingID>. Same booking + same day = same number;
// a later statement of the same booking gets a new date, which is right: its figures may have moved.
export const statementNumberFor = (bookingID, atISO) => {
  const hash = crypto.createHash("sha1").update(`statement:${bookingID}`).digest("hex").slice(0, 6).toUpperCase();
  return `BS-${ymdManila(atISO)}-${hash}`;
};

// j***@gmail.com -- enough to confirm it is the right inbox without showing the whole address.
export const maskEmail = (email) => {
  const [local, domain] = String(email || "").split("@");
  return local && domain ? `${local[0]}***@${domain}` : null;
};

// ───────────────────────── shared lookups ─────────────────────────
const makeStore = (db) => {
  const docById = async (collections, id) => {
    if (!id) return null;
    for (const c of collections) {
      const snap = await db.collection(c).doc(id).get();
      if (snap.exists) return { id: snap.id, ...snap.data() };
    }
    return null;
  };
  const firstWhere = async (collections, field, value) => {
    if (!value) return null;
    for (const c of collections) {
      const snap = await db.collection(c).where(field, "==", value).limit(1).get();
      if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }
    return null;
  };
  const rowsWhere = async (collections, field, value) => {
    const rows = new Map();
    for (const c of collections) {
      const snap = await db.collection(c).where(field, "==", value).get();
      snap.docs.forEach((d) => { if (!rows.has(d.id)) rows.set(d.id, { id: d.id, ...d.data() }); });
    }
    return [...rows.values()];
  };
  const vehicleName = async (carID) => {
    try {
      const car = await docById(["cars"], carID);
      if (!car?.modelID) return null;
      const model = await docById(["model"], car.modelID);
      if (!model) return null;
      const brand = await docById(["brand"], model.brandID);
      return [brand?.brandName, model.modelName].filter(Boolean).join(" ") || null;
    } catch { return null; }
  };
  // The customer's login email -- the ONLY address a receipt or statement is ever sent to.
  const emailOf = async (userID) => {
    try { return (await docById(["user"], userID))?.email || null; } catch { return null; }
  };
  return { docById, firstWhere, rowsWhere, vehicleName, emailOf };
};

const whenOf = (r) => toISO(r.settledAt) || toISO(r.processedAt) || toISO(r.createdAt) || "";
const byTime = (a, b) => whenOf(a).localeCompare(whenOf(b)) || String(a.id).localeCompare(String(b.id));

const labelOf = (e) => {
  if (e.direction === "out") {
    if (e.phase === "deposit_return") return "Security deposit returned";
    if (e.phase === "discount") return "Discount refund";
    if (e.phase === "discount_return") return "Discount credit returned";
    return `Refund of ${String(PHASE_LABEL[e.phase] || "payment").toLowerCase()}`;
  }
  return `${PHASE_LABEL[e.phase] || "Payment"} payment`;
};
const lineOf = (e) => ({
  id: e.id, date: whenOf(e) || null, label: labelOf(e), amount: num(e.amount), status: e.status,
  method: e.method || null, source: e.source || null, referenceNumber: e.referenceNumber || null,
});

// The online payment (gateway) fee the customer paid on top of ONE online penalty payment row. Not stored on the row (a
// row's amount is penalty money only): it is the fee on that amount at the penalty's saved gatewayFeeRate, or the current
// System Settings % for a penalty from before the rate was saved -- the same figure the checkout charged. Same as the
// customer backend's penaltyFeeOf (utils/receipt/receipt.util.js), so both sides show the same total.
// A penalty carries the fee only when its own amount is HIGHER than PENALTY_FEE_MIN_AMOUNT, the same number as the customer
// backend's utils/pricing.js (keep the two equal); a penalty with no online fee recorded (gatewayFeePaid is 0) shows none.
const PENALTY_FEE_MIN_AMOUNT = 1000;
const feePct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 0; };
const penaltyFeeOf = (row, penaltyDoc, settings) => {
  if (!row || row.direction !== "in" || row.phase !== "penalty" || row.source !== "online" || row.status !== "success") return 0;
  if (penaltyDoc && !(num(penaltyDoc.gatewayFeePaid) > 0)) return 0;
  const base = Math.max(0, round2(num(row.amount)));
  if (!((penaltyDoc && penaltyDoc.amount != null ? num(penaltyDoc.amount) : base) > PENALTY_FEE_MIN_AMOUNT)) return 0;
  const saved = penaltyDoc ? penaltyDoc.gatewayFeeRate : undefined;
  const rate = saved !== undefined && saved !== null && saved !== "" ? saved : settings?.gatewayFeePercent;
  return Math.round(base * feePct(rate) / 100);
};

// ───────────────────────── one-money-movement receipt ─────────────────────────
export const makeReceiptBuilder = ({ db, resolveName = async (id) => id, getSettings = async () => ({}), markCopies = true }) => {
  const { docById, firstWhere, rowsWhere, vehicleName, emailOf } = makeStore(db);
  const entryRows = (field, value) => rowsWhere(ENTRY_COLLECTIONS, field, value);

  // A reprint is a COPY. Staff prints are written to the audit log with the receipt number, so look there.
  // (The customer backend turns this off: a customer opening their own receipt is not a "reprint".)
  const alreadyPrinted = async (entry, receiptNo) => {
    if (!markCopies) return false;
    try {
      if (!entry.paymentID) return false;
      const snap = await db.collection("auditLogs").where("paymentID", "==", entry.paymentID).get();
      return snap.docs.some((d) => String(d.data().description || "").includes(receiptNo));
    } catch { return false; }
  };

  const buildReceipt = async ({ entryID, printedByUserID = null }) => {
    const entry = await docById(ENTRY_COLLECTIONS, entryID);
    if (!entry) throw httpError(404, "Money movement not found.");
    if (entry.status !== "success") throw httpError(409, "Only a completed money movement has a receipt.");

    const kind = kindOf(entry);

    // Rows from ONE checkout that covered several penalties share a groupID -> one receipt, one line each.
    let rows = [entry];
    if (entry.groupID) {
      const group = (await entryRows("groupID", entry.groupID))
        .filter((r) => r.status === "success" && r.direction === entry.direction && r.phase === entry.phase);
      if (group.length) rows = group.sort(byTime);
    }

    const [booking, payment] = await Promise.all([
      firstWhere(["bookings", "bookingArchives"], "bookingID", entry.bookingID),
      firstWhere(["payments", "paymentsArchives"], "paymentID", entry.paymentID),
    ]);
    const customerID = entry.userID || booking?.userID || payment?.userID || null;

    // ---- lines (what was PAID / RETURNED in this movement)
    const lines = [];
    let penalties = null;   // penalty receipts only: the charges behind each payment and where each penalty stands
    let note = null;
    const depositAtMs = payment?.depositSettledAt ? new Date(toISO(payment.depositSettledAt)).getTime() : 0;
    const depositPool = num(payment?.depositSettled);   // grows with each penalty taken from the held deposit

    for (const [idx, r] of rows.entries()) {
      if (kind === "penalty") {
        const p = await docById(PENALTY_COLLECTIONS, r.penaltyID);
        const items = Array.isArray(p?.lineItems)
          ? p.lineItems.filter((i) => i && (i.description || num(i.amount))).map((i) => ({ description: i.description || "Charge", amount: num(i.amount) }))
          : [];

        // Every successful payment on THIS penalty, to split "paid before" from "this payment".
        const all = r.penaltyID
          ? (await entryRows("penaltyID", r.penaltyID)).filter((e) => e.direction === "in" && e.status === "success" && e.phase === "penalty")
          : [r];
        const rWhen = whenOf(r);
        const earlier = (e) => whenOf(e) < rWhen || (whenOf(e) === rWhen && String(e.id) < String(r.id));
        const paidBefore = round2(all.filter((e) => e.id !== r.id && earlier(e)).reduce((x, e) => x + num(e.amount), 0));
        const paidAll = round2(all.reduce((x, e) => x + num(e.amount), 0));

        // A deposit offset moves no money, so it has no entry. penalties.paidAmount counts it, though: whatever
        // paidAmount holds beyond the real payments was covered by the security deposit (never more than the
        // deposit settlement actually used). It counts as "before" unless it was settled after this payment.
        const depositCovered = p ? Math.min(Math.max(0, round2(num(p.paidAmount) - paidAll)), depositPool) : 0;
        const coveredByDeposit = depositCovered > 0 && (!depositAtMs || depositAtMs <= (rWhen ? new Date(rWhen).getTime() : Infinity)) ? depositCovered : 0;
        const total = p ? num(p.amount) : null;

        penalties ||= [];
        penalties.push({
          penaltyID: r.penaltyID || null, items, total, paidBefore, thisPayment: num(r.amount), coveredByDeposit,
          remaining: total == null ? null : Math.max(0, round2(total - paidBefore - coveredByDeposit - num(r.amount))),
        });
        lines.push({ label: rows.length > 1 ? `Penalty payment ${idx + 1}` : "Penalty payment", detail: r.penaltyID || null, amount: num(r.amount) });
        // Paid online: the customer was also charged the online payment fee, so the receipt shows it as its own line
        // (a P105 payment must total P105, not P100).
        const fee = penaltyFeeOf(r, p, await getSettings().catch(() => ({})));
        if (fee > 0) lines.push({ label: "Online payment fee", detail: r.penaltyID || null, amount: fee, isFee: true });
      } else if (kind === "payment") {
        lines.push({ label: `${PHASE_LABEL[r.phase] || "Payment"} payment`, detail: null, amount: num(r.amount) });
      } else if (kind === "deposit_return") {
        lines.push({ label: "Security deposit returned", detail: null, amount: num(r.amount) });
      } else if (r.phase === "discount") {
        // cash / online money handed back because a staff discount exceeded what the customer still owed
        lines.push({ label: "Discount refund", detail: null, amount: num(r.amount) });
        note = payment?.discountReason ? `Discount reason: ${payment.discountReason}` : "Refund of the amount paid above the discounted total.";
      } else if (r.phase === "discount_return") {
        // the held discount credit going back with the deposit (its own payout, separate from the deposit return)
        lines.push({ label: "Discount credit returned", detail: null, amount: num(r.amount) });
      } else {
        lines.push({ label: `Refund of ${String(PHASE_LABEL[r.phase] || "payment").toLowerCase()}`, detail: null, amount: num(r.amount) });
      }
    }
    const total = round2(lines.reduce((s, l) => s + l.amount, 0));

    // ---- balance after a booking payment (deposit / balance receipts only)
    let summary = null;
    if (kind === "payment" && payment) {
      const bookingTotal = round2(num(payment.amount) - num(payment.discountAmount));
      const mine = whenOf(entry);
      const paidSoFar = round2((await entryRows("paymentID", entry.paymentID))
        .filter((r) => r.direction === "in" && r.status === "success" && (r.phase === "deposit" || r.phase === "balance")
          && (whenOf(r) < mine || r.id === entry.id || (whenOf(r) === mine && String(r.id) < String(entry.id))))
        .reduce((s, r) => s + num(r.amount), 0));
      summary = { bookingTotal, paidToDate: paidSoFar, balanceAfter: Math.max(0, round2(bookingTotal - paidSoFar)) };
    }

    // deposit return slip: how the held deposit was used (the settlement itself moves no money, only the return does)
    let depositSummary = null;
    if (kind === "deposit_return" && payment && num(payment.securityDeposit) > 0) {
      depositSummary = { held: num(payment.securityDeposit), usedForPenalties: num(payment.depositSettled), returned: total };
    }

    const when = whenOf(rows[0]) || whenOf(entry) || null;   // a combined penalty receipt is dated by its first row
    const receiptNo = receiptNumberFor(entry, kind, when);
    const [settings, customerName, customerEmail, handledByName, printedByName, vehicle, isCopy] = await Promise.all([
      getSettings().catch(() => ({})),
      customerID ? resolveName(customerID).catch(() => "—") : "—",
      emailOf(customerID),
      entry.processedBy ? resolveName(entry.processedBy).catch(() => null) : null,
      printedByUserID ? resolveName(printedByUserID).catch(() => null) : null,
      vehicleName(booking?.carID),
      alreadyPrinted(entry, receiptNo),
    ]);

    return {
      entryID: entry.id, receiptNo, kind, title: titleFor(entry, kind), isCopy,
      direction: entry.direction, date: when,
      business: {
        name: settings?.storeName || "ARL Car Rental",
        address: settings?.storeAddress || null,
        phone: settings?.storePhone || null,
        email: settings?.storeEmail || null,
      },
      customer: { name: customerName, emailMasked: maskEmail(customerEmail) },
      booking: {
        bookingID: entry.bookingID || null, vehicle,
        startDateTime: toISO(booking?.startDateTime), endDateTime: toISO(booking?.endDateTime),
      },
      lines, total, note, penalties, depositSummary,
      method: entry.method || null, source: entry.source || null,
      referenceNumber: entry.referenceNumber || null,
      handledBy: entry.source === "in_person" ? handledByName : null,
      summary,
      printedBy: printedByName, printedAt: new Date().toISOString(),
      // for the audit log / ownership check done by the caller
      _email: customerEmail,
      _audit: { paymentID: entry.paymentID || null, bookingID: entry.bookingID || null },
    };
  };

  return { buildReceipt };
};

// ───────────────────────── booking statement ─────────────────────────
//   1. Payments    every successful deposit / balance payment, numbered, with the balance left on the booking
//   2. Penalties   every penalty with its charges, what was paid (cash / online) and what the security deposit covered
//   3. Deposit     how the security deposit was used / returned, and any refunds (only when there is something to show)
//   4. Pending     money movements that are not done yet -- listed, NEVER counted in a total
//   5. Overall     charges, paid, still owed, refunded, net received
// `movements` is the same money, newest last, as ONE flat list (every successful payment, penalty payment, refund and
// deposit return, penalties paid together folded into one row) with the receipt number and the entry that opens it --
// what the customer app lists as "money flow".
// It is a snapshot "as of" the moment it is built -- a statement mid-rental shows unpaid penalties as still owed and
// never implies the booking is settled.
export const makeStatementBuilder = ({ db, resolveName = async (id) => id, getSettings = async () => ({}), now = () => new Date() }) => {
  const { firstWhere, rowsWhere, vehicleName, emailOf } = makeStore(db);

  const buildStatement = async ({ bookingID, printedByUserID = null }) => {
    if (!bookingID) throw httpError(400, "A booking is required.");

    const [booking, payment, allEntries, penaltyRows] = await Promise.all([
      firstWhere(["bookings", "bookingArchives"], "bookingID", bookingID),
      firstWhere(["payments", "paymentsArchives"], "bookingID", bookingID),
      rowsWhere(ENTRY_COLLECTIONS, "bookingID", bookingID),
      rowsWhere(PENALTY_COLLECTIONS, "bookingID", bookingID),
    ]);
    // Staff discounts are written as "internal" rows (no cash moves: value just changes bucket). They are not payments or
    // refunds, so they stay off the money flow and the pending list; the discount itself is on `charges`.
    const entries = allEntries.filter((e) => e.direction !== "internal");
    if (!booking && !payment && allEntries.length === 0 && penaltyRows.length === 0) throw httpError(404, "Booking not found.");
    entries.sort(byTime);

    // For the online payment fee on penalty payments (see penaltyFeeOf).
    const feeSettings = await getSettings().catch(() => ({}));
    const penaltyDocOf = (id) => penaltyRows.find((p) => (p.penaltyID || p.id) === id) || null;
    const feeOfRow = (e) => penaltyFeeOf(e, penaltyDocOf(e.penaltyID), feeSettings);

    const done = (e) => e.status === "success";
    const bookingPayments = entries.filter((e) => e.direction === "in" && done(e) && (e.phase === "deposit" || e.phase === "balance"));
    const penaltyPayments = entries.filter((e) => e.direction === "in" && done(e) && e.phase === "penalty");
    const refunds = entries.filter((e) => e.direction === "out" && done(e) && e.phase !== "deposit_return");
    const depositReturns = entries.filter((e) => e.direction === "out" && done(e) && e.phase === "deposit_return");
    // Not done yet. "failed" / "cancelled" attempts moved no money and are left off the statement.
    const pendingRows = entries.filter((e) => e.status === "pending" || e.status === "unrefundable");

    // ---- booking charges and payments
    const customerID = booking?.userID || payment?.userID || entries.find((e) => e.userID)?.userID || penaltyRows.find((p) => p.userID)?.userID || null;
    const cancelled = String(booking?.status || "").toLowerCase() === "cancelled";
    let charges = null;
    if (payment) {
      const gross = num(payment.amount);
      const discount = num(payment.discountAmount);
      charges = {
        gross, discount, discountReason: discount > 0 ? payment.discountReason || null : null,
        total: round2(gross - discount),
        securityDeposit: num(payment.securityDeposit),
      };
    }
    const bookingPaid = sum(bookingPayments);
    // A cancelled booking owes nothing more: whatever was paid is dealt with through its refund.
    const balanceRemaining = charges && !cancelled ? Math.max(0, round2(charges.total - bookingPaid)) : 0;

    // ---- penalties
    // A deposit offset moves no money, so it has no entry. penalties.paidAmount counts it, though: whatever paidAmount
    // holds beyond the real payments was covered by the security deposit. The deposit can only cover as much as was
    // actually used (payments.depositSettled), so that pool is handed out penalty by penalty, oldest first.
    let depositPool = num(payment?.depositSettled);   // grows with each penalty taken from the held deposit
    const penalties = [];
    for (const p of penaltyRows.sort((a, b) => String(toISO(a.createdAt) || "").localeCompare(String(toISO(b.createdAt) || "")) || String(a.id).localeCompare(String(b.id)))) {
      const status = p.status || "Confirmed";
      // A penalty the customer was never told about isn't on their paperwork: one no supervisor has confirmed yet
      // (UnderReview) and one a supervisor rejected in review (Discarded). discardedFromReview covers old rows that were
      // saved as Voided + that flag before the Discarded status existed.
      if (status === "UnderReview" || status === "Discarded" || p.discardedFromReview) continue;
      const active = status === "Confirmed";
      const mine = penaltyPayments.filter((e) => e.penaltyID === (p.penaltyID || p.id));
      const paid = sum(mine);
      const amount = num(p.amount);
      let covered = 0;
      if (active) {
        covered = Math.min(Math.max(0, round2(num(p.paidAmount) - paid)), depositPool);
        depositPool = round2(depositPool - covered);
      }
      const items = Array.isArray(p.lineItems)
        ? p.lineItems.filter((i) => i && (i.description || num(i.amount))).map((i) => ({ description: i.description || "Charge", amount: num(i.amount) }))
        : [];
      penalties.push({
        penaltyID: p.penaltyID || p.id, status, active, reason: !active ? p.statusReason || null : null, date: toISO(p.createdAt),
        items: items.length ? items : [{ description: "Penalty charge", amount }],
        amount, paid, coveredByDeposit: covered,
        outstanding: active ? Math.max(0, round2(amount - paid - covered)) : 0,
        payments: mine.map((e) => ({ ...lineOf(e), fee: feeOfRow(e) })),   // fee = online payment fee on top of that payment (0 if none)
      });
    }
    const live = penalties.filter((p) => p.active);
    const penaltyTotals = {
      count: live.length,
      charged: sum(live, (p) => p.amount), paid: sum(live, (p) => p.paid),
      coveredByDeposit: sum(live, (p) => p.coveredByDeposit), outstanding: sum(live, (p) => p.outstanding),
    };

    // ---- security deposit and refunds
    const heldDeposit = num(payment?.securityDeposit);
    const returnedAmount = depositReturns.length ? sum(depositReturns) : num(payment?.depositReturned);
    const deposit = heldDeposit > 0
      ? { held: heldDeposit, status: payment?.depositStatus || null, usedForPenalties: num(payment?.depositSettled), returned: returnedAmount }
      : null;
    const refundTotal = sum(refunds);

    // ---- overall
    const paidIn = round2(bookingPaid + sum(penaltyPayments));
    const overall = {
      totalCharges: round2((charges?.total || 0) + penaltyTotals.charged),
      paidIn,
      coveredByDeposit: penaltyTotals.coveredByDeposit,
      stillOwed: round2(balanceRemaining + penaltyTotals.outstanding),
      refunded: refundTotal,
      depositReturned: returnedAmount,
      netReceived: round2(paidIn - refundTotal - returnedAmount),
      // Online payment fees the customer paid on top of penalty payments. Not part of paidIn / stillOwed (those are
      // penalty money); shown so the statement adds up to what the customer was really charged.
      onlineFees: round2(penaltyPayments.reduce((s, e) => s + feeOfRow(e), 0)),
    };

    // ---- money flow: every successful movement, one row per receipt (penalties paid together fold into one)
    const movements = [];
    const byGroup = new Map();
    for (const e of entries.filter(done)) {
      const groupKey = e.groupID ? `${e.direction}:${e.phase}:${e.groupID}` : null;
      if (groupKey && byGroup.has(groupKey)) {
        const m = byGroup.get(groupKey);
        m.amount = round2(m.amount + num(e.amount));
        m.fee = round2(num(m.fee) + feeOfRow(e));
        m.count += 1;
        continue;
      }
      const kind = kindOf(e);
      const when = whenOf(e) || null;
      const m = {
        entryID: e.id, receiptNo: receiptNumberFor(e, kind, when), kind, title: titleFor(e, kind),
        label: labelOf(e), direction: e.direction, date: when, amount: num(e.amount), count: 1,
        fee: feeOfRow(e),   // online payment fee on top of `amount` (penalty payments paid online only; 0 otherwise)
        method: e.method || null, source: e.source || null, referenceNumber: e.referenceNumber || null,
      };
      movements.push(m);
      if (groupKey) byGroup.set(groupKey, m);
    }

    const pending = pendingRows.map((e) => ({ ...lineOf(e), direction: e.direction }));
    const asOf = now().toISOString();
    const statementNo = statementNumberFor(bookingID, asOf);

    const [settings, customerName, customerEmail, printedByName, vehicle] = await Promise.all([
      getSettings().catch(() => ({})),
      customerID ? resolveName(customerID).catch(() => "—") : "—",
      emailOf(customerID),
      printedByUserID ? resolveName(printedByUserID).catch(() => null) : null,
      vehicleName(booking?.carID),
    ]);

    return {
      statementNo, title: "Booking Statement", asOf,
      business: {
        name: settings?.storeName || "ARL Car Rental",
        address: settings?.storeAddress || null,
        phone: settings?.storePhone || null,
        email: settings?.storeEmail || null,
      },
      customer: { name: customerName, emailMasked: maskEmail(customerEmail) },
      booking: {
        bookingID, vehicle, status: booking?.status || null,
        startDateTime: toISO(booking?.startDateTime), endDateTime: toISO(booking?.endDateTime),
      },
      charges,
      payments: bookingPayments.map(lineOf),
      paymentTotals: { paid: bookingPaid, balanceRemaining },
      penalties, penaltyTotals,
      deposit,
      refunds: refunds.map(lineOf),
      movements,
      pending,
      overall,
      printedBy: printedByName, printedAt: asOf,
      // for the audit log / ownership check done by the caller
      _email: customerEmail,
      _audit: { paymentID: payment?.paymentID || null, bookingID },
      _ownerID: customerID,
    };
  };

  return { buildStatement };
};

// ───────────────────────── one shared email limit ─────────────────────────
// ONE small record per receipt / statement in `receiptEmails`, written by BOTH backends, so an email sent by staff and one
// sent by the customer share the same 5-minute limit. `claim` runs in a transaction: two simultaneous requests cannot both
// pass. It stamps the time BEFORE the send; if the send then fails, `release` puts the previous value back so a failed send
// doesn't lock the customer out.
export const EMAIL_COOLDOWN_MS = 5 * 60 * 1000;
export const EMAIL_LIMIT_COLLECTION = "receiptEmails";
const safeKey = (k) => String(k).replace(/[\/\s]/g, "_");
// receipts are keyed by receipt number (stable for an entry); statements by booking (the number carries today's date)
export const emailKeyFor = {
  receipt: (receiptNo) => safeKey(`receipt_${receiptNo}`),
  statement: (bookingID) => safeKey(`statement_${bookingID}`),
};

export const makeEmailLimiter = (db, { now = () => Date.now(), cooldownMs = EMAIL_COOLDOWN_MS } = {}) => {
  const ref = (key) => db.collection(EMAIL_LIMIT_COLLECTION).doc(key);
  const waitFrom = (rec) => Math.max(0, Math.ceil((toMs(rec?.lastSentAt) + cooldownMs - now()) / 1000));

  // -> { ok: true, previous } | { ok: false, wait }   (wait = seconds left)
  const claim = (key, by = null) => db.runTransaction(async (tx) => {
    const snap = await tx.get(ref(key));
    const prev = snap.exists ? snap.data() : null;
    const wait = waitFrom(prev);
    if (wait > 0) return { ok: false, wait };
    tx.set(ref(key), { lastSentAt: new Date(now()), lastSentBy: by });
    return { ok: true, previous: prev };
  });
  const release = async (key, previous) => {
    try { previous ? await ref(key).set(previous) : await ref(key).delete(); } catch { /* best effort */ }
  };
  // for an email that was just sent outside the claim flow (the automatic one after a payment settles)
  const record = async (key, by = null) => {
    try { await ref(key).set({ lastSentAt: new Date(now()), lastSentBy: by }); } catch { /* best effort */ }
  };
  const cooldownLeft = async (key) => {
    try { const s = await ref(key).get(); return s.exists ? waitFrom(s.data()) : 0; } catch { return 0; }
  };
  return { claim, release, record, cooldownLeft };
};


// ───────────────────────── bound to the real Firestore ─────────────────────────
const deps = { db, resolveName: resolveUserName, getSettings: getSystemSettings };
export const { buildReceipt } = makeReceiptBuilder(deps);
export const { buildStatement } = makeStatementBuilder(deps);
// the 5-minute email limit, shared with the customer backend (collection `receiptEmails`)
export const emailLimiter = makeEmailLimiter(db);