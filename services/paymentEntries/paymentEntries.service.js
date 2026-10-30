// paymentEntries -- bound to the real Firestore connection.
// READERS: anything that reads a payment / penalty document and uses a field the PHASE 2 cleanup removes
// (PayMongo payment ids, fees, channel, paidAt, confirmedBy ...) must load it through
// hydratePayments / hydratePaymentData / hydratePenalties. See scripts/migrate-payment-entries.js.
// STEP 1: the legacy payment fields stay the source of truth. After a payment is written,
// syncPaymentEntries() re-derives its deposit / balance rows from the document, so the
// entries can never disagree with it. It never throws (a failure must not block a payment).
//
// The read-only view for the admin screens (listEntries) lives at the bottom of this file.
//
// Rows live in their own collection keyed by paymentID / bookingID and are NOT archived with
// the booking (same convention as driverAssignments / cancellationRequests): a restore
// reconnects them automatically. Only the permanent delete in bookingArchives.service.js
// removes them (getEntryRefsForBooking).
import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
import { stripArchiveMeta } from "../archives/archiveMeta.js";
import { makeEntriesDb } from "./paymentEntries.core.js";
import { buildRefundEntries } from "./paymentEntries.mapper.js";
import { ENTRY_COLLECTION } from "../../models/paymentEntries/paymentEntry.model.js";
import { getDepositView } from "../payments/paymentHelpers.js";
import { hasDiscountLedger } from "../payments/discountLedger.js";

const svc = makeEntriesDb(db);

export const syncPaymentEntries       = svc.syncPaymentEntries;
export const syncRefundEntries        = svc.syncRefundEntries;
export const hydrateRefundRequests    = svc.hydrateRefundRequests;
export const writeRefundEntries       = svc.writeRefundEntries;
export const getEntriesForPaymentIDs  = svc.getEntriesForPaymentIDs;
export const getEntriesForPenaltyIDs  = svc.getEntriesForPenaltyIDs;
export const hydratePayments          = svc.hydratePayments;
export const hydratePaymentData       = svc.hydratePaymentData;
export const hydratePenalties         = svc.hydratePenalties;
export const getEntryRefsForBooking   = svc.getEntryRefsForBooking;
export { ENTRY_COLLECTION };

// ============================================================================
// READ-ONLY VIEW (was paymentEntries.view.js + paymentEntries.view.service.js)
// ============================================================================
// Read-only view of the money rows for the admin screens. `db` is injected so it runs against a fake in tests.
//
// One call answers "where did the money go?" for a payment, a penalty, a refund request or a whole booking:
// every row (in AND out), who handled it, and totals. It reads paymentEntries AND paymentEntryArchives (a booking's
// rows move to the archive collection when it is deleted), a live row winning if both exist -- the same rule as
// services/archives/entryArchiveHydrate.service.js. It never needs the parent document, so it also works for
// archived and orphaned records.

const LIVE = "paymentEntries";
const ARCHIVE = "paymentEntryArchives";
// request key -> the column on the row
const COLUMN = { paymentID: "paymentID", penaltyID: "penaltyID", refundRequestID: "refundReqID", bookingID: "bookingID" };

const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

export const makeEntriesView = ({ db, resolveName = async (id) => id }) => {
  const loadRows = async (filter) => {
    const key = Object.keys(COLUMN).find((k) => filter?.[k]);
    if (!key) return [];
    const rows = new Map();
    for (const [collection, archived] of [[LIVE, false], [ARCHIVE, true]]) {     // live first: it wins
      const snap = await db.collection(collection).where(COLUMN[key], "==", filter[key]).get();
      snap.docs.forEach((d) => { if (!rows.has(d.id)) rows.set(d.id, { id: d.id, archived, ...stripArchiveMeta(d.data()) }); });
    }
    // A refund with no stored rows (an older request, or rows that were never written) still has its parts /
    // manualRefund / unrefundable on the request itself. Build the rows from that, read-only, so the movements
    // show instead of an empty list. Nothing is saved here. A Pending / Rejected request has no parts, so it
    // correctly stays empty.
    if (rows.size === 0 && key === "refundRequestID") {
      for (const [collection, archived] of [["refundRequests", false], ["refundArchives", true]]) {
        let snap = await db.collection(collection).doc(filter.refundRequestID).get();
        let data = snap.exists ? snap.data() : null;
        if (!data) {
          const q = await db.collection(collection).where("refundRequestID", "==", filter.refundRequestID).limit(1).get();
          data = q.empty ? null : q.docs[0].data();
        }
        if (!data) continue;
        const req = stripArchiveMeta(data);
        const { entries } = buildRefundEntries({ ...req, refundRequestID: req.refundRequestID || filter.refundRequestID }, filter.refundRequestID, { now: req.updatedAt || req.createdAt || new Date() });
        entries.forEach((e) => rows.set(e.paymentEntryID, { id: e.paymentEntryID, archived, ...e }));
        break;
      }
    }
    return [...rows.values()];
  };

  const summarize = (rows) => {
    const sum = (f) => round2(rows.filter(f).reduce((s, r) => s + num(r.amount), 0));
    const paidIn = sum((r) => r.direction === "in" && r.status === "success" && r.phase !== "penalty");
    const refundedOut = sum((r) => r.direction === "out" && r.status === "success" && r.phase !== "deposit_return");
    const depositReturned = sum((r) => r.direction === "out" && r.status === "success" && r.phase === "deposit_return");
    return {
      count: rows.length,
      paidIn,
      penaltyPaid: sum((r) => r.direction === "in" && r.status === "success" && r.phase === "penalty"),
      refundedOut,
      depositReturned,
      refundPending: sum((r) => r.direction === "out" && r.status === "pending"),
      unrefundable: sum((r) => r.direction === "out" && r.status === "unrefundable"),
      failed: sum((r) => r.status === "failed"),
      netHeld: round2(paidIn - refundedOut - depositReturned),
    };
  };

  // ---- ADJUSTMENTS: value that moved WITHOUT cash ------------------------------------------------------------------
  // Nothing here is saved or added to a row: they are read from what the payment / penalties already store, so old
  // bookings work too and the money totals (summarize) can never include them.
  //   discount        payments.discountAmount (+ discountReason / discountBy / discountAt) -- LEGACY discounts only;
  //                   a ledger discount is in the entries as "internal" rows (no cash, so never in the money totals)
  //   deposit_offset  penalty money taken from the held deposit = penalties.paidAmount minus the cash entries on it,
  //                   capped by what the deposit settlement says it used (depositSettled)
  const readOne = async (live, archive, idField, id) => {
    const doc = await db.collection(live).doc(id).get();
    if (doc.exists) return { id: doc.id, ...doc.data() };
    const snap = await db.collection(archive).where(idField, "==", id).limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...stripArchiveMeta(snap.docs[0].data()) };
  };
  const readMany = async (live, archive, field, value, idField) => {
    const out = new Map();
    for (const c of [live, archive]) {                                       // live first: it wins
      const snap = await db.collection(c).where(field, "==", value).get();
      snap.docs.forEach((d) => { const data = c === archive ? stripArchiveMeta(d.data()) : d.data(); const k = data[idField] || d.id; if (!out.has(k)) out.set(k, { id: d.id, ...data }); });
    }
    return [...out.values()];
  };

  const loadAdjustments = async (filter, rows, nameOf) => {
    if (filter?.refundRequestID) return [];
    let payments = [];
    let penalties = [];
    if (filter?.paymentID) {
      const pay = await readOne("payments", "paymentsArchives", "paymentID", filter.paymentID);
      payments = pay ? [pay] : [];
      penalties = await readMany("penalties", "penaltyArchives", "paymentID", filter.paymentID, "penaltyID");
    } else if (filter?.bookingID) {
      payments = await readMany("payments", "paymentsArchives", "bookingID", filter.bookingID, "paymentID");
      penalties = await readMany("penalties", "penaltyArchives", "bookingID", filter.bookingID, "penaltyID");
    } else if (filter?.penaltyID) {
      const pen = await readOne("penalties", "penaltyArchives", "penaltyID", filter.penaltyID);
      penalties = pen ? [pen] : [];
      const pay = pen?.paymentID ? await readOne("payments", "paymentsArchives", "paymentID", pen.paymentID) : null;
      payments = pay ? [pay] : [];
    }
    const payIDOf = (p) => p.paymentID || p.id;
    const list = [];

    for (const pay of payments) {
      // A discount belongs to the payment, so a single-penalty view does not show it. A LEDGER discount is not listed
      // here: every one of its steps is its own "internal" row in the entries above. Only a legacy discount (given
      // before the ledger, no rows) is read from the payment.
      if (!filter.penaltyID && num(pay.discountAmount) > 0 && !hasDiscountLedger(pay)) {
        list.push({
          id: `adj_discount_${payIDOf(pay)}`, kind: "discount", label: "Discount given", amount: round2(num(pay.discountAmount)),
          reason: pay.discountReason || null, byName: await nameOf(pay.discountBy), date: toISO(pay.discountAt),
          paymentID: payIDOf(pay), bookingID: pay.bookingID ?? null, penaltyID: null,
        });
      }

      const dep = getDepositView(pay); // the payment's deposit settlement (flat or old nested storage); null if none was ever recorded
      let left = dep?.settled ? num(dep.deducted) : 0; // what the deposit actually paid toward penalties
      if (left <= 0) continue;
      const mine = penalties
        .filter((p) => (p.paymentID || null) === payIDOf(pay))
        .sort((a, b) => (toISO(a.createdAt) || "").localeCompare(toISO(b.createdAt) || ""));   // the deposit pays them oldest first
      for (const pen of mine) {
        const penID = pen.penaltyID || pen.id;
        const cash = rows
          .filter((r) => r.penaltyID === penID && r.direction === "in" && r.phase === "penalty" && r.status === "success")
          .reduce((sum, r) => sum + num(r.amount), 0);
        const fromDeposit = Math.min(left, round2(num(pen.paidAmount) - cash));
        if (!(fromDeposit > 0)) continue;
        left = round2(left - fromDeposit);
        list.push({
          id: `adj_deposit_${penID}`, kind: "deposit_offset", label: "Penalty paid from security deposit", amount: round2(fromDeposit),
          reason: null, byName: null, date: toISO(dep.settledAt),
          paymentID: payIDOf(pay), bookingID: pay.bookingID ?? null, penaltyID: penID,
        });
      }
    }
    if (filter?.penaltyID) return list.filter((a) => a.penaltyID === filter.penaltyID);
    return list.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.id.localeCompare(b.id));
  };

  const listEntries = async (filter) => {
    const rows = await loadRows(filter);
    const names = new Map();
    const nameOf = async (id) => { if (!id) return null; if (!names.has(id)) names.set(id, await resolveName(id).catch(() => id)); return names.get(id); };
    const when = (r) => toISO(r.settledAt) || toISO(r.processedAt) || toISO(r.createdAt) || "";
    const entries = [];
    for (const r of rows.sort((a, b) => when(a).localeCompare(when(b)) || String(a.id).localeCompare(String(b.id)))) {
      entries.push({
        id: r.id, archived: r.archived,
        paymentID: r.paymentID ?? null, bookingID: r.bookingID ?? null, refundReqID: r.refundReqID ?? null, penaltyID: r.penaltyID ?? null,
        direction: r.direction, phase: r.phase, source: r.source ?? null, method: r.method ?? null, amount: num(r.amount), status: r.status,
        referenceNumber: r.referenceNumber ?? null, sessionID: r.sessionID ?? null, transactionFee: r.transactionFee ?? null,
        processedBy: r.processedBy ?? null, processedByName: await nameOf(r.processedBy), processedAt: toISO(r.processedAt), settledAt: toISO(r.settledAt),
        groupID: r.groupID ?? null, errorNote: r.transactionErrorNote ?? null, reason: r.reason ?? null, createdAt: toISO(r.createdAt),
      });
    }
    // Never let a problem reading the adjustments hide the real money rows.
    let adjustments = [];
    try { adjustments = await loadAdjustments(filter, rows, nameOf); } catch (e) { console.warn("[PAYMENT ENTRIES] adjustments skipped:", e.message); }
    return { entries, summary: summarize(entries), adjustments };
  };

  return { listEntries, summarize };
};

// Bound to the real Firestore connection.
export const { listEntries } = makeEntriesView({ db, resolveName: resolveUserName });