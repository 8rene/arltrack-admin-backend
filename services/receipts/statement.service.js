// Booking Statement: ONE overall document for a whole booking (the receipts are one per money movement).
//
//   1. Payments    every successful deposit / balance payment, numbered, with the balance left on the booking
//   2. Penalties   every penalty with its charges, what was paid (cash / online) and what the security deposit covered
//   3. Deposit     how the security deposit was used / returned, and any refunds (only when there is something to show)
//   4. Pending     money movements that are not done yet -- listed, NEVER counted in a total
//   5. Overall     charges, paid, still owed, refunded, net received
//
// Like a receipt it is generated on demand and nothing about it is stored, so it can never disagree with the money
// rows. It is a snapshot "as of" the moment it is printed -- a statement printed mid-rental shows unpaid penalties as
// still owed and says nothing about the booking being settled.
//
// `makeStatementBuilder` takes `db`, `resolveName` and `getSettings` so it can run against a fake;
// `buildStatement` / `emailCooldownLeft` at the bottom are bound to the real Firestore.
import crypto from "crypto";
import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";
import { maskEmail } from "./receipt.service.js";

const ENTRY_COLLECTIONS = ["paymentEntries", "paymentEntryArchives"];   // live first: a live row wins
const PENALTY_COLLECTIONS = ["penalties", "penaltyArchives"];

const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (rows, f = (r) => r.amount) => round2(rows.reduce((s, r) => s + num(f(r)), 0));

const EMAIL_COOLDOWN_MS = 5 * 60 * 1000;   // one email per statement every 5 minutes
const httpError = (status, message) => Object.assign(new Error(message), { status });

const PHASE_LABEL = { deposit: "Deposit", balance: "Balance", penalty: "Penalty" };

// BS-<yyMMdd (Manila) the statement was generated>-<6 hex chars of the bookingID>. Same booking + same day = same number;
// a later statement of the same booking gets a new date, which is right: its figures may have moved.
export const statementNumberFor = (bookingID, atISO) => {
  const d = atISO ? new Date(atISO) : null;
  const ymd = d && !isNaN(d) ? d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).replace(/-/g, "").slice(2) : "000000";
  const hash = crypto.createHash("sha1").update(`statement:${bookingID}`).digest("hex").slice(0, 6).toUpperCase();
  return `BS-${ymd}-${hash}`;
};

export const makeStatementBuilder = ({ db, resolveName = async (id) => id, getSettings = async () => ({}), now = () => new Date() }) => {
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
  const emailOf = async (userID) => {
    try { return (await docById(["user"], userID))?.email || null; } catch { return null; }
  };

  // Seconds left before this statement may be emailed again (0 = go ahead). Read from the audit log, which already
  // records every send with the statement number, so no extra field is written anywhere.
  const emailCooldownLeft = async ({ bookingID, statementNo }) => {
    try {
      if (!bookingID) return 0;
      const snap = await db.collection("auditLogs").where("bookingID", "==", bookingID).get();
      const times = snap.docs.map((d) => d.data())
        .filter((a) => String(a.description || "").includes(statementNo) && String(a.description).includes("emailed"))
        .map((a) => new Date(toISO(a.createdAt) || 0).getTime());
      const last = times.length ? Math.max(...times) : 0;
      return Math.max(0, Math.ceil((last + EMAIL_COOLDOWN_MS - now().getTime()) / 1000));
    } catch { return 0; }
  };

  const whenOf = (r) => toISO(r.settledAt) || toISO(r.processedAt) || toISO(r.createdAt) || "";
  const byTime = (a, b) => whenOf(a).localeCompare(whenOf(b)) || String(a.id).localeCompare(String(b.id));

  const labelOf = (e) => {
    if (e.direction === "out") {
      if (e.phase === "deposit_return") return "Security deposit returned";
      if (String(e.id).endsWith("_discountrefund")) return "Discount refund";
      return `Refund of ${String(PHASE_LABEL[e.phase] || "payment").toLowerCase()}`;
    }
    return `${PHASE_LABEL[e.phase] || "Payment"} payment`;
  };
  const lineOf = (e) => ({
    id: e.id, date: whenOf(e) || null, label: labelOf(e), amount: num(e.amount), status: e.status,
    method: e.method || null, source: e.source || null, referenceNumber: e.referenceNumber || null,
  });

  const buildStatement = async ({ bookingID, printedByUserID = null }) => {
    if (!bookingID) throw httpError(400, "A booking is required.");

    const [booking, payment, entries, penaltyRows] = await Promise.all([
      firstWhere(["bookings", "bookingArchives"], "bookingID", bookingID),
      firstWhere(["payments", "paymentsArchives"], "bookingID", bookingID),
      rowsWhere(ENTRY_COLLECTIONS, "bookingID", bookingID),
      rowsWhere(PENALTY_COLLECTIONS, "bookingID", bookingID),
    ]);
    if (!booking && !payment && entries.length === 0 && penaltyRows.length === 0) throw httpError(404, "Booking not found.");
    entries.sort(byTime);

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
    let depositPool = num(payment?.depositSettled);
    const penalties = [];
    for (const p of penaltyRows.sort((a, b) => String(toISO(a.createdAt) || "").localeCompare(String(toISO(b.createdAt) || "")) || String(a.id).localeCompare(String(b.id)))) {
      const status = p.status || "Confirmed";
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
        payments: mine.map(lineOf),
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
    };

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
      pending,
      overall,
      printedBy: printedByName, printedAt: asOf,
      // for the audit log written by the controller
      _email: customerEmail,
      _audit: { paymentID: payment?.paymentID || null, bookingID },
    };
  };

  return { buildStatement, emailCooldownLeft };
};

export const { buildStatement, emailCooldownLeft } = makeStatementBuilder({ db, resolveName: resolveUserName, getSettings: getSystemSettings });