import { db } from "../../config/firebaseConnection/firebase.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { createNotification, notifyStaff, resolveNotification } from "../notification/notification.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";
import { syncRefundEntries, ENTRY_COLLECTION } from "../paymentEntries/paymentEntries.service.js";
import { cancelBookingForRefund } from "./refundRequest.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sync a refund's FINAL result from PayMongo (admin side).
//
// Why this exists: admin sends a refund to PayMongo and records it as "pending". The final result
// (succeeded / failed) used to arrive ONLY through the `payment.refund.updated` webhook, which lands on the
// CUSTOMER backend. If that webhook was missed (not subscribed, wrong signing secret, wrong URL, outage) the
// refund stayed on "Waiting for PayMongo" forever, even though the money had already gone back.
//
// This asks PayMongo directly (GET /v1/refunds/:id) and applies the answer with the SAME rules as the webhook
// (customer backend: controllers/paymongo/paymongo.controller.js -> applyRefundPartResult):
//   * the refund's "out" row in paymentEntries -> success / failed
//   * the refund request -> Refunded (every part succeeded and no hand-back outstanding) / Failed
//   * the payment -> Refunded once the request is Refunded
//   * transaction log + audit log + customer notification (+ staff alert when a payout fails)
//
// Safe to run any number of times, and safe to run next to the webhook: every write is transactional and a row
// that already carries the result is skipped, so nothing is logged, notified or counted twice. The transaction-log
// ids are the same ones the webhook uses, so even a race cannot create a second log row.
// ─────────────────────────────────────────────────────────────────────────────

const PAYMONGO_V1 = "https://api.paymongo.com/v1";
const paymongoHeaders = () => ({
  "Content-Type": "application/json",
  "Authorization": `Basic ${Buffer.from((process.env.PAYMONGO_SECRET_KEY || "") + ":").toString("base64")}`,
});

const peso = (n) => `₱${Number(n || 0).toLocaleString()}`;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ── ask PayMongo ──────────────────────────────────────────────────────────────
// Returns "pending" | "succeeded" | "failed". Throws on a network / API problem (the caller decides what to do).
export const fetchPaymongoRefundStatus = async (refundID) => {
  if (!process.env.PAYMONGO_SECRET_KEY) throw fail("PAYMONGO_SECRET_KEY is not set on the admin backend.", 500);
  let res;
  try {
    res = await fetch(`${PAYMONGO_V1}/refunds/${encodeURIComponent(refundID)}`, { method: "GET", headers: paymongoHeaders() });
  } catch (e) {
    throw fail("Could not reach PayMongo. Please try again.", 502);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw fail(body?.errors?.[0]?.detail || `PayMongo could not find or return refund ${refundID}.`, res.status === 404 ? 404 : 502);
  }
  const status = String(body?.data?.attributes?.status || "").toLowerCase();
  if (!status) throw fail(`PayMongo returned no status for refund ${refundID}.`, 502);
  return status;
};

// A refund request no longer stores userID (it is on the cancellation row that carries refundRequestID). Old docs still do.
const resolveRefundUserID = async (r) => {
  if (r.userID) return r.userID;
  try {
    const row = await db.collection("cancellationRequests").where("refundRequestID", "==", r.refundRequestID).limit(1).get();
    if (!row.empty && row.docs[0].data().userID) return row.docs[0].data().userID;
    if (r.paymentID) {
      const pay = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!pay.empty) return pay.docs[0].data().userID || null;
    }
  } catch (e) {
    console.error("[REFUND SYNC] could not resolve the customer for refund", r.refundRequestID, e.message);
  }
  return null;
};

// ── a staff discount refunded online (an "out" row with phase "discount" and no refund request) ──
const checkedBy = (actor) => (actor === "system" ? "checked automatically by the scheduled job" : "checked from the admin side");

const settleDiscountRow = async (entryDoc, { refundID, refundStatus, actor }) => {
  const rowRef = entryDoc.ref;
  const rowStatus = refundStatus === "succeeded" ? "success" : "failed";
  const out = await db.runTransaction(async (t) => {
    const cur = await t.get(rowRef);
    const d = cur.data();
    if (d.status === rowStatus || d.status === "success") return { skip: true };   // never downgrade a success
    const at = new Date();
    t.update(rowRef, {
      status: rowStatus,
      settledAt: rowStatus === "success" ? (d.settledAt || at) : null,
      transactionErrorNote: rowStatus === "failed" ? "PayMongo reported the discount refund as failed." : null,
      updatedAt: at,
    });
    return { row: d, wasFailed: d.status === "failed" };
  });
  if (out.skip) return { found: true, skipped: true };

  createTransactionLog({
    logID: `${out.row.paymentID}_discount_${refundID}`,
    bookingID: out.row.bookingID, paymentID: out.row.paymentID, userID: out.row.userID || null,
    type: "Refund", amount: out.row.amount || 0,
    status: rowStatus === "success" ? "Refunded" : "Failed",
    paymentMethod: null, referenceNumber: refundID,
    description: rowStatus === "success"
      ? "Discount refund confirmed by PayMongo."
      : "PayMongo reported the discount refund as failed.",
    performedBy: actor || "—",
  });

  // Keep the payment in step with the row (see the webhook): a FAILED refund is owed again, a late success after a failure
  // puts it back.
  try {
    const paySnap = out.row.paymentID
      ? await db.collection("payments").where("paymentID", "==", out.row.paymentID).limit(1).get()
      : { empty: true };
    if (!paySnap.empty) {
      if (rowStatus === "failed") {
        await paySnap.docs[0].ref.update({ refundIssued: false, refundDue: Number(out.row.amount) || 0, updatedAt: new Date() });
        await notifyStaff({
          type: "refund_due", refID: out.row.bookingID, refCollection: "bookings",
          title: "Refund due to customer",
          message: `The online refund of ${peso(out.row.amount)} for the discount on booking ${out.row.bookingID} failed. It needs to be returned to the customer in store.`,
        });
      } else if (out.wasFailed) {
        await paySnap.docs[0].ref.update({ refundIssued: true, refundDue: 0, updatedAt: new Date() });
        await resolveNotification("refund_due", out.row.bookingID);
      }
    }
  } catch (e) {
    console.error("[REFUND SYNC] failed to sync the payment after a discount refund result:", e.message);
  }
  auditSafe({
    action: "update",
    description: `Discount refund of ${peso(out.row.amount)} for booking ${out.row.bookingID}: ${rowStatus === "success" ? "confirmed" : "reported as failed"} by PayMongo (${checkedBy(actor)}).`,
    userID: actor || null, bookingID: out.row.bookingID || null, paymentID: out.row.paymentID || null,
  });
  return { found: true, discount: true, state: rowStatus };
};

// ── one deposit_return / discount_return row, settled on its own ──
const settlePayoutRow = async (entryDoc, { refundID, refundStatus, actor }) => {
  const payoutPhase = entryDoc.data().phase;
  const isCredit = payoutPhase === "discount_return";
  const word = isCredit ? "discount" : "deposit";
  const rowRef = entryDoc.ref;
  const rowStatus = refundStatus === "succeeded" ? "success" : "failed";
  const out = await db.runTransaction(async (t) => {
    const cur = await t.get(rowRef);
    const d = cur.data();
    if (d.status === rowStatus || d.status === "success") return { skip: true };
    const at = new Date();
    t.update(rowRef, {
      status: rowStatus,
      settledAt: rowStatus === "success" ? (d.settledAt || at) : null,
      transactionErrorNote: rowStatus === "failed" ? `PayMongo reported the ${word} refund as failed.` : null,
      transactionFee: null,
      updatedAt: at,
    });
    return { row: d };
  });
  if (out.skip) return { found: true, skipped: true };
  const row = out.row;
  const amt = Number(row.amount) || 0;

  createTransactionLog({
    // Same logIDs as the webhook / the in-store path, so a payout is only ever logged as returned once.
    logID: rowStatus === "success"
      ? (isCredit ? `${row.paymentID}_discount_returned` : `${row.paymentID}_deposit_settled`)
      : `${row.paymentID}_${payoutPhase}_failed_${refundID}`,
    bookingID: row.bookingID, paymentID: row.paymentID, userID: row.userID || null,
    type: isCredit ? "Discount" : "DepositReturn", amount: amt,
    status: rowStatus === "success" ? "Success" : "Failed",
    paymentMethod: null, referenceNumber: refundID,
    description: rowStatus === "success"
      ? (isCredit ? "Discount credit return confirmed by PayMongo." : "Security deposit return confirmed by PayMongo.")
      : (isCredit ? "PayMongo reported the discount credit return as failed." : "PayMongo reported the security deposit return as failed."),
    performedBy: actor || "—",
  });

  if (rowStatus === "success") {
    // The "refund due" alert is per booking: only clear it when the booking's OTHER payout is not still failed.
    let otherStillFailed = false;
    try {
      const sib = await db.collection(ENTRY_COLLECTION).where("paymentID", "==", row.paymentID).where("direction", "==", "out").get();
      const millis = (v) => { const dt = v && v.toDate ? v.toDate() : v ? new Date(v) : null; return dt && !isNaN(dt) ? dt.getTime() : 0; };
      const newest = {};
      sib.docs.forEach((doc) => {
        const e = doc.data();
        if (e.phase !== "deposit_return" && e.phase !== "discount_return") return;
        const at = millis(e.createdAt || e.processedAt);
        if (!newest[e.phase] || at >= newest[e.phase].at) newest[e.phase] = { at, status: e.status };
      });
      otherStillFailed = Object.entries(newest).some(([phase, v]) => phase !== payoutPhase && v.status === "failed");
    } catch (e) { otherStillFailed = true; /* best-effort: worst case the alert stays up until staff clear it */ }
    if (!otherStillFailed) await resolveNotification("refund_due", row.bookingID).catch(() => {});
    if (row.userID) {
      await createNotification({
        type: "refund_completed", userID: row.userID, dedupeKey: `${payoutPhase}:${refundID}`,
        refID: row.bookingID || null, refCollection: "bookings",
        title: isCredit ? "Discount Returned" : "Deposit Returned",
        message: isCredit
          ? `Your discount of ${peso(amt)} has been returned to your original payment method.`
          : `Your security deposit of ${peso(amt)} has been returned to your original payment method.`,
      }).catch((e) => console.error(`[REFUND SYNC] failed to write the ${word}-returned notification:`, e.message));
    }
  } else {
    await notifyStaff({
      type: "refund_due", refID: row.bookingID, refCollection: "bookings",
      title: isCredit ? "Discount return needs follow-up" : "Deposit return needs follow-up",
      message: `PayMongo could not complete the online return of the ${peso(amt)} ${word} for booking ${row.bookingID}. Retry it or hand it back in store from the Refunds page.`,
    }).catch((e) => console.error(`[REFUND SYNC] failed to notify staff about a failed ${word} return:`, e.message));
    if (row.userID) {
      await createNotification({
        type: "refund_failed", userID: row.userID, dedupeKey: `${payoutPhase}:${refundID}`,
        refID: row.bookingID || null, refCollection: "bookings",
        title: isCredit ? "Discount return delayed" : "Deposit return delayed",
        message: `We couldn't send your ${peso(amt)} ${word} back to your original payment method. Our team will follow up to return it another way.`,
      }).catch((e) => console.error(`[REFUND SYNC] failed to write the ${word}-return-failed notification:`, e.message));
    }
  }
  auditSafe({
    action: "update",
    description: rowStatus === "success"
      ? `${isCredit ? "Discount" : "Deposit"} return of ${peso(amt)} confirmed by PayMongo for booking ${row.bookingID} (${checkedBy(actor)}).`
      : `PayMongo reported the ${word} return of ${peso(amt)} as failed for booking ${row.bookingID} (${checkedBy(actor)}).`,
    userID: actor || null, bookingID: row.bookingID || null, paymentID: row.paymentID || null,
  });
  return { found: true, [isCredit ? "discountReturn" : "depositReturn"]: true, state: rowStatus };
};

// ── a refund REQUEST part (deposit / balance charge refunded through PayMongo) ──
const applyRequestPartResult = async ({ refundID, refundStatus, entrySnap, actor }) => {
  const entryReqID = entrySnap.empty ? null : entrySnap.docs[0].data().refundReqID;
  let snap = { empty: true };
  if (entryReqID) {
    const byEntry = await db.collection("refundRequests").doc(entryReqID).get();
    if (byEntry.exists) snap = { empty: false, docs: [byEntry] };
  }
  if (snap.empty) snap = await db.collection("refundRequests").where("paymongoRefundID", "==", refundID).limit(1).get();   // legacy single-refund requests
  if (snap.empty) {
    console.warn("[REFUND SYNC] no matching refundRequest for refundID:", refundID);
    return { found: false };
  }

  const reqRef = snap.docs[0].ref;
  const partStatus = refundStatus === "succeeded" ? "succeeded" : "failed";

  const outcome = await db.runTransaction(async (t) => {
    const s2 = await t.get(reqRef);
    const r = s2.data();

    // The parts live in paymentEntries ("out" rows), not on the request. All reads come before any write.
    const rowsSnap = await t.get(db.collection(ENTRY_COLLECTION).where("refundReqID", "==", r.refundRequestID || reqRef.id));
    const outRows = rowsSnap.docs.filter((d) => d.data().direction === "out");
    const partRows = outRows.filter((d) => d.data().source === "online" && d.data().status !== "unrefundable");
    // A row with handBackFor is staff paying back, themselves, a part PayMongo refused. It COVERS the failed part it points at.
    const manualRow = outRows.find((d) => d.data().source === "in_person" && !d.data().handBackFor);
    const coveredIDs = new Set(outRows.filter((d) => d.data().handBackFor && d.data().status === "success").map((d) => d.data().handBackFor));
    const target = partRows.find((d) => d.data().referenceNumber === refundID);

    if (target) {
      const rowStatus = partStatus === "succeeded" ? "success" : "failed";
      const td = target.data();
      if (td.status === rowStatus) return { skip: true };   // already recorded (the webhook got there first)

      const statuses = partRows.map((d) => {
        const s = d.id === target.id ? rowStatus : d.data().status;
        return s === "failed" && coveredIDs.has(d.id) ? "success" : s;
      });
      const anyFailed = statuses.some((s) => s === "failed");
      const allSucceeded = statuses.every((s) => s === "success");
      const manualOutstanding = !!(manualRow && manualRow.data().status !== "success");
      const newStatus = anyFailed ? "Failed" : (allSucceeded && !manualOutstanding ? "Refunded" : r.status);
      const at = new Date();

      t.update(target.ref, { status: rowStatus, settledAt: rowStatus === "success" ? (td.settledAt || at) : null, updatedAt: at });
      t.update(reqRef, { status: newStatus, updatedAt: at });
      return {
        request: { ...r, status: newStatus },
        part: { kind: td.phase, amount: td.amount },
        finalized: newStatus === "Refunded" && r.status !== "Refunded",
        failedNow: newStatus === "Failed" && r.status !== "Failed",
      };
    }

    // No row carries this refund id: a request that was never migrated to paymentEntries. Fall back to the request's own
    // parts[]. Requests created before multi-part refunds have no parts[]: the single paymongoRefundID is one part.
    const parts = Array.isArray(r.parts) && r.parts.length
      ? r.parts.map((x) => ({ ...x }))
      : [{ kind: "deposit", paymongoRefundID: r.paymongoRefundID, amount: Number(r.amount ?? r.toRefundAmount) || 0, status: "pending" }];

    const idx = parts.findIndex((x) => x.paymongoRefundID === refundID);
    if (idx < 0) return { skip: true };
    if (parts[idx].status === partStatus) return { skip: true };
    parts[idx].status = partStatus;

    const anyFailed = parts.some((x) => x.status === "failed");
    const allSucceeded = parts.every((x) => x.status === "succeeded");
    const manualOutstanding = !!(r.manualRefund && !r.manualRefund.issued);
    const newStatus = anyFailed ? "Failed" : (allSucceeded && !manualOutstanding ? "Refunded" : r.status);

    t.update(reqRef, { parts, status: newStatus, updatedAt: new Date() });
    return {
      legacy: true,
      request: { ...r, parts, status: newStatus },
      part: parts[idx],
      finalized: newStatus === "Refunded" && r.status !== "Refunded",
      failedNow: newStatus === "Failed" && r.status !== "Failed",
    };
  });

  if (outcome.skip) return { found: true, skipped: true };
  if (outcome.legacy) await syncRefundEntries(reqRef.id);   // un-migrated request: derive its "out" rows now. Never throws.

  const { request: r, part } = outcome;
  const now = new Date();
  const customerID = await resolveRefundUserID(r);
  const refundAmount = Number(r.toRefundAmount ?? r.amount ?? 0);

  createTransactionLog({
    logID: `${r.refundRequestID}_refund_${refundID}`,
    bookingID: r.bookingID, paymentID: r.paymentID, refundReqID: r.refundRequestID,
    userID: customerID || null,
    type: "Refund", amount: part.amount || 0,
    status: partStatus === "succeeded" ? "Refunded" : "Failed",
    paymentMethod: null, referenceNumber: refundID,
    description: partStatus === "succeeded"
      ? `Refund of the ${part.kind || "payment"} charge confirmed by PayMongo.`
      : `PayMongo reported the refund of the ${part.kind || "payment"} charge as failed.`,
    performedBy: actor || "—",
  });

  if (outcome.finalized) {
    if (r.paymentID) {
      const paymentSnap = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!paymentSnap.empty) await paymentSnap.docs[0].ref.update({ status: "Refunded", updatedAt: now });
    }
    // Approval already cancels the booking; this only matters for requests approved before that rule existed (no-op otherwise).
    await cancelBookingForRefund(r.bookingID, "Cancelled: refund completed.", actor || null).catch(() => {});

    auditSafe({
      action: "update",
      description: `Refund ${r.refundRequestID} completed — ${peso(refundAmount)} returned for payment ${r.paymentID} (confirmed by PayMongo, ${checkedBy(actor)}).`,
      userID: actor || customerID || null, bookingID: r.bookingID || null, paymentID: r.paymentID, refundRequestID: r.refundRequestID,
    });
    if (customerID) {
      await createNotification({
        type: "refund_completed", userID: customerID, refID: r.bookingID || null, refCollection: "bookings",
        title: "Refund Completed",
        message: `Your refund of ${peso(refundAmount)} has been returned.`,
      }).catch((e) => console.error("[REFUND SYNC] failed to write refund_completed notification:", e.message));
    }
  } else if (partStatus === "failed") {
    auditSafe({
      action: "update",
      description: `Refund ${r.refundRequestID}: PayMongo reported the ${part.kind || ""} refund as failed (${checkedBy(actor)}).`,
      userID: actor || customerID || null, bookingID: r.bookingID || null, paymentID: r.paymentID, refundRequestID: r.refundRequestID,
    });
    if (outcome.failedNow && customerID) {
      await createNotification({
        type: "refund_failed", userID: customerID, refID: r.bookingID || null, refCollection: "bookings",
        title: "Refund Failed",
        message: `Your approved refund of ${peso(refundAmount)} could not be completed by PayMongo. Please contact support.`,
      }).catch((e) => console.error("[REFUND SYNC] failed to write refund_failed notification:", e.message));
    }
  }
  return { found: true, finalized: !!outcome.finalized, state: partStatus === "succeeded" ? "success" : "failed" };
};

// Apply a TERMINAL PayMongo result ("succeeded" | "failed") for one refund id. Same routing as the webhook.
export const applyRefundResult = async ({ refundID, refundStatus, actor = null }) => {
  const entrySnap = await db.collection(ENTRY_COLLECTION).where("referenceNumber", "==", refundID).where("direction", "==", "out").get();

  if (!entrySnap.empty && entrySnap.docs[0].data().phase === "discount") {
    return settleDiscountRow(entrySnap.docs[0], { refundID, refundStatus, actor });
  }
  // A deposit + discount return can share ONE PayMongo refund id (two rows, one refund): settle every matching row.
  const payoutDocs = entrySnap.docs.filter((d) => d.data().phase === "deposit_return" || d.data().phase === "discount_return");
  if (payoutDocs.length) {
    let last = { found: true };
    for (const entryDoc of payoutDocs) last = await settlePayoutRow(entryDoc, { refundID, refundStatus, actor });
    return last;
  }
  return applyRequestPartResult({ refundID, refundStatus, entrySnap, actor });
};

// ── public entry points ───────────────────────────────────────────────────────

// Ask PayMongo about ONE refund id and apply the answer. Returns { refundID, paymongoStatus, applied, ... }.
export const syncOneRefund = async (refundID, { actor = null } = {}) => {
  const paymongoStatus = await fetchPaymongoRefundStatus(refundID);
  if (paymongoStatus !== "succeeded" && paymongoStatus !== "failed") {
    return { refundID, paymongoStatus, applied: false };   // still processing at PayMongo
  }
  const result = await applyRefundResult({ refundID, refundStatus: paymongoStatus, actor });
  return { refundID, paymongoStatus, applied: !result.skipped && result.found !== false, ...result };
};

// The refund ids still waiting on PayMongo: online "out" rows that were sent (have a re_... id) and are still "pending".
const pendingRefundIDs = (docs, { olderThanMs = 0 } = {}) => {
  const cutoff = Date.now() - olderThanMs;
  const millis = (v) => { const dt = v && v.toDate ? v.toDate() : v ? new Date(v) : null; return dt && !isNaN(dt) ? dt.getTime() : 0; };
  const ids = new Set();
  docs.forEach((d) => {
    const e = d.data();
    if (e.direction !== "out" || e.source !== "online" || e.status !== "pending" || !e.referenceNumber) return;
    if (olderThanMs && millis(e.processedAt || e.createdAt) > cutoff) return;   // give the webhook time to arrive first
    ids.add(e.referenceNumber);
  });
  return [...ids];
};

const runSync = async (refundIDs, actor) => {
  const out = { checked: refundIDs.length, completed: 0, failed: 0, stillPending: 0, errors: [] };
  for (const refundID of refundIDs) {
    try {
      const r = await syncOneRefund(refundID, { actor });
      if (!r.applied) { if (r.paymongoStatus === "pending") out.stillPending += 1; continue; }
      if (r.paymongoStatus === "succeeded") out.completed += 1; else out.failed += 1;
    } catch (e) {
      out.errors.push(`${refundID}: ${e.message}`);
    }
  }
  return out;
};

// Staff button: check every refund of ONE booking that is still waiting on PayMongo (a refund request, a discount refund,
// a deposit / discount return). No age limit: staff asked for it.
export const syncRefundsForBooking = async (bookingID, { actor = null } = {}) => {
  if (!bookingID) throw fail("bookingID is required.", 400);
  const snap = await db.collection(ENTRY_COLLECTION).where("bookingID", "==", bookingID).where("direction", "==", "out").get();
  const ids = pendingRefundIDs(snap.docs);
  if (!ids.length) throw fail("Nothing is waiting on PayMongo for this booking. Refresh the page — it may already be updated.", 404);
  const result = await runSync(ids, actor);
  if (result.errors.length && !result.completed && !result.failed && !result.stillPending) {
    throw fail(result.errors[0], 502);
  }
  return result;
};

// Cron: every refund that has been "pending" for more than `olderThanMinutes` (the webhook normally lands within seconds).
export const syncPendingRefunds = async ({ olderThanMinutes = 30 } = {}) => {
  const snap = await db.collection(ENTRY_COLLECTION).where("direction", "==", "out").where("status", "==", "pending").get();
  const ids = pendingRefundIDs(snap.docs, { olderThanMs: olderThanMinutes * 60 * 1000 });
  return runSync(ids, "system");
};