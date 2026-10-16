// Receipt builder for ONE money movement (a paymentEntries row). (was receipt.core.js + receipt.service.js)
//
// A receipt is generated on demand from the entry -- nothing about it is stored, so it can never disagree with the
// money rows. `makeReceiptBuilder` takes `db`, `resolveName` and `getSettings` so it can run against a fake; `buildReceipt` at the
// bottom is the one bound to the real Firestore.
//
//   kind "payment"         money in, phase deposit | balance      -> "Payment Receipt"
//   kind "penalty"         money in, phase penalty                -> "Penalty Receipt" (one line per penalty paid together, via groupID)
//   kind "refund"          money out, a refund of deposit/balance/penalty -> "Refund Slip"
//   kind "deposit_return"  money out, the security deposit handed back   -> "Deposit Return Slip"
//
// Only a SUCCESSFUL entry gets one: pending / failed / cancelled / unrefundable movements are not receipts.
import crypto from "crypto";
import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
import { getSystemSettings } from "../systemSettings/systemSettings.service.js";

const LIVE = "paymentEntries";
const ARCHIVE = "paymentEntryArchives";

const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

export const KIND_TITLES = {
  payment: "Payment Receipt",
  penalty: "Penalty Receipt",
  refund: "Refund Slip",
  deposit_return: "Security Deposit Return Slip",
};
const KIND_PREFIX = { payment: "RC", penalty: "PN", refund: "RF", deposit_return: "DR" };
const PHASE_LABEL = { deposit: "Deposit", balance: "Balance", penalty: "Penalty", deposit_return: "Security deposit" };

export const kindOf = (e) => {
  if (e.direction === "out") return e.phase === "deposit_return" ? "deposit_return" : "refund";
  return e.phase === "penalty" ? "penalty" : "payment";
};

// Same entry always gets the same number: <prefix>-<yyMMdd (Manila time) of the money moving>-<6 hex chars of the id>.
// Penalties paid together share one receipt, so they hash the groupID instead of the individual entry id.
export const receiptNumberFor = (entry, kind, whenISO) => {
  const d = whenISO ? new Date(whenISO) : null;
  const ymd = d && !isNaN(d)
    ? d.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }).replace(/-/g, "").slice(2)
    : "000000";
  const key = entry.groupID ? `group:${entry.groupID}` : String(entry.id);
  const hash = crypto.createHash("sha1").update(key).digest("hex").slice(0, 6).toUpperCase();
  return `${KIND_PREFIX[kind]}-${ymd}-${hash}`;
};

// j***@gmail.com -- enough for staff to confirm it is the right inbox without showing the whole address.
export const maskEmail = (email) => {
  const [local, domain] = String(email || "").split("@");
  return local && domain ? `${local[0]}***@${domain}` : null;
};

const EMAIL_COOLDOWN_MS = 5 * 60 * 1000;   // one email per receipt every 5 minutes

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const makeReceiptBuilder = ({ db, resolveName = async (id) => id, getSettings = async () => ({}) }) => {
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
  // live first, then archive; a live row wins (same rule as the Money movements panel).
  const rowsWhere = async (field, value) => {
    const rows = new Map();
    for (const c of [LIVE, ARCHIVE]) {
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

  // The customer's login email -- the ONLY address a receipt is ever sent to.
  const emailOf = async (userID) => {
    try { return (await docById(["user"], userID))?.email || null; } catch { return null; }
  };

  // Seconds left before this receipt may be emailed again (0 = go ahead). Read from the audit log, which already
  // records every send with the receipt number, so no extra field is written anywhere.
  const emailCooldownLeft = async ({ paymentID, receiptNo }) => {
    try {
      if (!paymentID) return 0;
      const snap = await db.collection("auditLogs").where("paymentID", "==", paymentID).get();
      const times = snap.docs.map((d) => d.data())
        .filter((a) => String(a.description || "").includes(receiptNo) && String(a.description).includes("emailed"))
        .map((a) => new Date(toISO(a.createdAt) || 0).getTime());
      const last = times.length ? Math.max(...times) : 0;
      return Math.max(0, Math.ceil((last + EMAIL_COOLDOWN_MS - Date.now()) / 1000));
    } catch { return 0; }
  };

  const whenOf = (r) => toISO(r.settledAt) || toISO(r.processedAt) || toISO(r.createdAt) || "";

  const alreadyPrinted = async (entry, receiptNo) => {
    // A reprint is a COPY. Every print is written to the audit log with the receipt number, so look there.
    try {
      if (!entry.paymentID) return false;
      const snap = await db.collection("auditLogs").where("paymentID", "==", entry.paymentID).get();
      return snap.docs.some((d) => String(d.data().description || "").includes(receiptNo));
    } catch { return false; }
  };

  const buildReceipt = async ({ entryID, printedByUserID = null }) => {
    const entry = await docById([LIVE, ARCHIVE], entryID);
    if (!entry) throw httpError(404, "Money movement not found.");
    if (entry.status !== "success") throw httpError(409, "Only a completed money movement has a receipt.");

    const kind = kindOf(entry);

    // Rows from ONE checkout that covered several penalties share a groupID -> one receipt, one line each.
    let rows = [entry];
    if (entry.groupID) {
      const group = (await rowsWhere("groupID", entry.groupID))
        .filter((r) => r.status === "success" && r.direction === entry.direction && r.phase === entry.phase);
      if (group.length) rows = group.sort((a, b) => whenOf(a).localeCompare(whenOf(b)) || String(a.id).localeCompare(String(b.id)));
    }

    const [booking, payment] = await Promise.all([
      firstWhere(["bookings", "bookingArchives"], "bookingID", entry.bookingID),
      firstWhere(["payments", "paymentsArchives"], "paymentID", entry.paymentID),
    ]);
    const customerID = entry.userID || booking?.userID || payment?.userID || null;

    // ---- lines
    const lines = [];
    for (const r of rows) {
      if (kind === "penalty") {
        const p = await docById(["penalties", "penaltyArchives"], r.penaltyID);
        const items = Array.isArray(p?.lineItems) ? p.lineItems.map((i) => i.description).filter(Boolean) : [];
        lines.push({ label: items.length ? items.join(", ") : `Penalty ${r.penaltyID || ""}`.trim(), detail: r.penaltyID || null, amount: num(r.amount) });
      } else if (kind === "payment") {
        lines.push({ label: `${PHASE_LABEL[r.phase] || "Payment"} payment`, detail: null, amount: num(r.amount) });
      } else if (kind === "deposit_return") {
        lines.push({ label: "Security deposit returned", detail: null, amount: num(r.amount) });
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
      const paidSoFar = round2((await rowsWhere("paymentID", entry.paymentID))
        .filter((r) => r.direction === "in" && r.status === "success" && (r.phase === "deposit" || r.phase === "balance")
          && (whenOf(r) < mine || r.id === entry.id || (whenOf(r) === mine && String(r.id) < String(entry.id))))
        .reduce((s, r) => s + num(r.amount), 0));
      summary = { bookingTotal, paidToDate: paidSoFar, balanceAfter: Math.max(0, round2(bookingTotal - paidSoFar)) };
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
      entryID: entry.id, receiptNo, kind, title: KIND_TITLES[kind], isCopy,
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
      lines, total,
      method: entry.method || null, source: entry.source || null,
      referenceNumber: entry.referenceNumber || null,
      handledBy: entry.source === "in_person" ? handledByName : null,
      summary,
      printedBy: printedByName, printedAt: new Date().toISOString(),
      // for the audit log written by the controller
      _email: customerEmail,
      _audit: { paymentID: entry.paymentID || null, bookingID: entry.bookingID || null },
    };
  };

  return { buildReceipt, emailCooldownLeft };
};

export const { buildReceipt, emailCooldownLeft } = makeReceiptBuilder({ db, resolveName: resolveUserName, getSettings: getSystemSettings });