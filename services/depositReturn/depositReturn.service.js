import { db } from "../../config/firebaseConnection/firebase.js";
import { createPaymongoRefund } from "../refundRequest/refundRequest.service.js";
import { hydratePaymentData, ENTRY_COLLECTION } from "../paymentEntries/paymentEntries.service.js";
import { resolvePaymongoIDs, getPaymentBreakdown } from "../payments/paymentBreakdown.js";
import { notifyStaff, resolveNotification, createNotification } from "../notification/notification.service.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";

// ─────────────────────────────────────────────
// Returning the security deposit ONLINE (through PayMongo) instead of by hand.
//
// A deposit return is one paymentEntries row: direction "out", phase "deposit_return".
//   in store : source "in_person", status "success" right away (staff handed it over)      -- see settleBooking
//   online   : source "online",    status "pending" until PayMongo confirms (the webhook in the customer backend flips it)
//
// Only the customer's FIRST payment (where the deposit was collected) can be partially refunded, and only when it was paid
// by GCash or Maya. QR Ph can only be refunded in full and cash was never on PayMongo, so those stay in-store.
//
// ORDER OF OPERATIONS (so a retry can never refund twice):
//   1. settleBooking() settles the deposit and saves the return row as "pending" in ONE Firestore transaction -- the claim.
//   2. Only then is PayMongo called (never inside a transaction), for exactly the amount that was saved.
//   3a. PayMongo accepted  -> the refund id is written onto the row; the webhook settles it later.
//   3b. PayMongo refused   -> the row is marked "failed" and staff are told to retry or hand it back in store.
// ─────────────────────────────────────────────

const lower = (v) => String(v == null ? "" : v).trim().toLowerCase();
const ONLINE_CHANNELS = ["gcash", "paymaya", "maya"];
const num = (v) => Number(v) || 0;
const peso = (n) => `₱${num(n).toLocaleString()}`;

const toMillis = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.getTime() : 0;
};
const isoOf = (d) => {
  const v = d && d.toDate ? d.toDate() : d ? new Date(d) : null;
  return v && !isNaN(v) ? v.toISOString() : null;
};

/**
 * Can this deposit go back through PayMongo? Pure.
 *   { ok: true, paymongoPaymentID, channel }  or  { ok: false, reason }
 */
export const planOnlineDepositReturn = (payment, amount) => {
  const ids = resolvePaymongoIDs(payment);
  const channel = lower(payment && payment.paymongoChannel);
  if (!ONLINE_CHANNELS.includes(channel)) {
    return { ok: false, reason: channel === "qrph"
      ? "The deposit was paid by QR Ph, which PayMongo can't partially refund. Hand it back in store."
      : "The deposit wasn't paid online with GCash or Maya, so it can only be handed back in store." };
  }
  if (!ids.deposit) {
    return { ok: false, reason: "This payment's PayMongo record is incomplete (no payment id for the deposit), so it can only be handed back in store." };
  }
  const collected = getPaymentBreakdown(payment).depositCollected;
  if (amount > collected) {
    return { ok: false, reason: `The amount to return (${peso(amount)}) is more than the first payment PayMongo received (${peso(collected)}).` };
  }
  return { ok: true, paymongoPaymentID: ids.deposit, channel: channel === "maya" ? "paymaya" : channel };
};

/** Same check from a booking's payment document id / bookingID, for the checklist (read-only, never throws). */
export const onlineDepositReturnOption = async (bookingID, amount) => {
  try {
    const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
    if (snap.empty) return { available: false, reason: "No payment record." };
    const payment = await hydratePaymentData(snap.docs[0].data(), snap.docs[0].id);
    const plan = planOnlineDepositReturn(payment, Math.max(0, num(amount)));
    return plan.ok ? { available: true, channel: plan.channel } : { available: false, reason: plan.reason };
  } catch {
    return { available: false, reason: "Couldn't check how the deposit was paid." };
  }
};

// Writes PayMongo's refund id onto the pending row. Retries a few times: the money has already gone, so losing this
// link would leave the row pending forever (the webhook finds the row by this id).
const attachRefundID = async (entryRef, refundID) => {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try { await entryRef.update({ referenceNumber: refundID, updatedAt: new Date() }); return true; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 300 * (i + 1))); }
  }
  console.error(`[DEPOSIT RETURN] could not save PayMongo refund id ${refundID} on row ${entryRef.id}:`, lastErr && lastErr.message);
  return false;
};

const failRow = async (entryRef, note) => {
  await entryRef.update({ status: "failed", settledAt: null, transactionErrorNote: String(note || "PayMongo refused the refund.").slice(0, 300), updatedAt: new Date() });
};

const notifyFailure = (bookingID, amount, note) => notifyStaff({
  type: "refund_due",
  refID: bookingID,
  refCollection: "bookings",
  title: "Deposit return needs follow-up",
  message: `The online return of the ${peso(amount)} deposit for booking ${bookingID} didn't go through${note ? ` (${note})` : ""}. Retry it on the Refunds page or hand it back in store.`,
}).catch((e) => console.error("[DEPOSIT RETURN] staff notify failed:", e.message));

/**
 * Steps 2 and 3 above, run right after settleBooking() has committed the pending row.
 * Never throws: the deposit is already settled, so the caller reports the outcome instead.
 * Returns { state: "processing" | "failed", refundID?, error? }.
 */
export const sendOnlineDepositReturn = async ({ bookingID, paymentID, entryID, amount, paymongoPaymentID, performedBy, customerUserID }) => {
  const entryRef = db.collection(ENTRY_COLLECTION).doc(entryID);
  let refundID;
  try {
    refundID = await createPaymongoRefund({ paymongoPaymentID, amount, reason: `Security deposit return for booking ${bookingID}` });
  } catch (e) {
    await failRow(entryRef, e.message).catch((err) => console.error("[DEPOSIT RETURN] could not mark the row failed:", err.message));
    await notifyFailure(bookingID, amount, e.message);
    auditSafe({ action: "update", userID: performedBy || null, bookingID, paymentID,
      description: `Online return of the ${peso(amount)} deposit for booking ${bookingID} was refused by PayMongo (${e.message}). Needs a retry or an in-store hand-back.` });
    return { state: "failed", error: e.message };
  }

  const linked = await attachRefundID(entryRef, refundID);
  auditSafe({ action: "update", userID: performedBy || null, bookingID, paymentID,
    description: `Deposit of ${peso(amount)} for booking ${bookingID} sent back through PayMongo (ref ${refundID}); waiting for PayMongo to confirm.${linked ? "" : " WARNING: the refund id could not be saved on the ledger row — match it by hand."}` });
  if (customerUserID) {
    createNotification({
      type: "deposit_return_processing", refID: bookingID, refCollection: "bookings", userID: customerUserID,
      title: "Deposit being returned",
      message: `Your security deposit of ${peso(amount)} is being returned to your original payment method. Please allow up to 24 hours for it to show.`,
    }).catch((e) => console.error("[DEPOSIT RETURN] customer notify failed:", e.message));
  }
  return { state: "processing", refundID };
};

// ─────────────────────────────────────────────
// Reading: every deposit return, for the Refunds page -- through PayMongo (pending / failed / refunded) AND in store.
// An in-store return is finished the moment it is saved ("refunded", via "in_store"), so it only ever shows up in the
// page's History, never under Under Process. Newest row per payment wins, so a retry or a hand-back supersedes the
// failed row.
// ─────────────────────────────────────────────
const stateOfRow = (row) => {
  const st = lower(row.status);
  if (st === "success") return "refunded";
  if (st === "failed") return "failed";
  return "processing";
};

export const getDepositReturns = async () => {
  const snap = await db.collection(ENTRY_COLLECTION).where("phase", "==", "deposit_return").where("direction", "==", "out").get();
  const byPayment = new Map();
  snap.docs.forEach((d) => {
    const row = { id: d.id, ...d.data() };
    const key = row.paymentID;
    if (!key) return;
    if (!byPayment.has(key)) byPayment.set(key, []);
    byPayment.get(key).push(row);
  });

  const items = [];
  for (const [paymentID, rows] of byPayment) {
    rows.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    const latest = rows[0];
    const at = latest.settledAt || latest.processedAt || latest.createdAt || null;

    let customerName = "—";
    try {
      const uid = latest.userID;
      if (uid) {
        const ud = await db.collection("userDetails").where("userID", "==", uid).limit(1).get();
        if (!ud.empty) {
          const { firstName = "", lastName = "" } = ud.docs[0].data();
          customerName = [firstName, lastName].filter(Boolean).join(" ").trim() || customerName;
        }
        if (customerName === "—") {
          const u = await db.collection("user").doc(uid).get();
          if (u.exists) customerName = u.data().username || u.data().email || "—";
        }
      }
    } catch { /* a name is cosmetic */ }

    items.push({
      paymentID,
      bookingID: latest.bookingID || null,
      customerName,
      createdAt: isoOf(rows[rows.length - 1].createdAt),
      refund: {
        state: stateOfRow(latest),
        amount: num(latest.amount),
        via: latest.source === "online" ? "paymongo" : "in_store",
        method: latest.method || null,
        referenceNumber: latest.referenceNumber || null,
        errorNote: latest.transactionErrorNote || null,
        at: isoOf(at),
      },
    });
  }
  return items;
};

/**
 * The newest deposit return of ONE booking, however it went back (in store or through PayMongo), for the Car Tracking
 * customer window. Read-only; returns null when nothing has been returned yet or the lookup fails.
 *   { via: "paymongo" | "in_store", state: "refunded" | "processing" | "failed", amount, method, referenceNumber, errorNote, at }
 */
export const getDepositReturnForBooking = async (bookingID) => {
  try {
    if (!bookingID) return null;
    const snap = await db.collection(ENTRY_COLLECTION).where("bookingID", "==", bookingID).where("phase", "==", "deposit_return").get();
    const rows = snap.docs.map((d) => d.data()).filter((r) => r.direction === "out");
    if (!rows.length) return null;
    rows.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
    const r = rows[0];
    return {
      via: r.source === "online" ? "paymongo" : "in_store",
      state: stateOfRow(r),
      amount: num(r.amount),
      method: r.method || null,
      referenceNumber: r.referenceNumber || null,
      errorNote: r.transactionErrorNote || null,
      at: isoOf(r.settledAt || r.processedAt || r.createdAt),
    };
  } catch {
    return null;
  }
};

// Read INSIDE the claim transaction: every deposit_return row of this payment must be a failed one before another is
// written. A pending or successful row means the money is already out (or on its way), so a second click, a retry racing a
// hand-back, or two staff at once all stop here. The query is part of the transaction, so a row written by the other
// request in the meantime makes this one fail instead of both succeeding.
const assertNothingAlreadyReturned = async (tx, paymentID) => {
  const q = await tx.get(db.collection(ENTRY_COLLECTION).where("paymentID", "==", paymentID).where("phase", "==", "deposit_return"));
  const live = q.docs.filter((d) => d.data().direction === "out" && lower(d.data().status) !== "failed");
  if (live.length) throw new Error("This deposit has already been returned, or a return is still in progress. Refresh and look again.");
};

/** The newest deposit_return row of a booking's payment, or null. */
const latestReturnRow = async (paymentID) => {
  const snap = await db.collection(ENTRY_COLLECTION).where("paymentID", "==", paymentID).where("phase", "==", "deposit_return").get();
  const rows = snap.docs.map((d) => ({ ref: d.ref, id: d.id, ...d.data() })).filter((r) => r.direction === "out");
  rows.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  return rows[0] || null;
};

const loadPayment = async (bookingID) => {
  if (!bookingID) throw new Error("bookingID is required.");
  const snap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) throw new Error("No payment record found for this booking.");
  const payment = await hydratePaymentData(snap.docs[0].data(), snap.docs[0].id);
  return { payment, paymentID: payment.paymentID || snap.docs[0].id };
};

/**
 * Retry an online deposit return PayMongo refused. The failed row stays as the record of what happened; a NEW pending row
 * is written first (the claim), then PayMongo is called, same order as the first attempt. Nothing is retried while one
 * is in flight or after one succeeded, so the same money can't be refunded twice.
 */
export const retryDepositReturn = async (bookingID, retriedBy) => {
  const { payment, paymentID } = await loadPayment(bookingID);
  const latest = await latestReturnRow(paymentID);
  if (!latest) throw new Error("There is no deposit return on this booking.");
  const st = lower(latest.status);
  if (st === "pending") throw new Error("This deposit return is still processing at PayMongo — wait for it to finish.");
  if (st === "success") throw new Error("This deposit has already been returned.");

  const amount = num(latest.amount);
  const plan = planOnlineDepositReturn(payment, amount);
  if (!plan.ok) throw new Error(plan.reason);

  // Claim: the new pending row, and only if the newest row is still the failed one.
  const entryRef = db.collection(ENTRY_COLLECTION).doc();
  await db.runTransaction(async (tx) => {
    await assertNothingAlreadyReturned(tx, paymentID);
    const now = new Date();
    tx.set(entryRef, {
      paymentEntryID: entryRef.id, paymentID, bookingID, userID: payment.userID || null,
      refundReqID: null, penaltyID: null, direction: "out", phase: "deposit_return",
      source: "online", method: null, amount, status: "pending", referenceNumber: null,
      sessionID: null, transactionFee: null, processedBy: retriedBy || null, processedAt: now, settledAt: null,
      groupID: null, transactionErrorNote: null, createdAt: now, updatedAt: now,
    });
  });

  const out = await sendOnlineDepositReturn({
    bookingID, paymentID, entryID: entryRef.id, amount, paymongoPaymentID: plan.paymongoPaymentID,
    performedBy: retriedBy, customerUserID: payment.userID || null,
  });
  if (out.state === "failed") throw new Error(`PayMongo refused it again: ${out.error}`);
  return { bookingID, amount, refundID: out.refundID };
};

/**
 * The online return failed (or staff would rather not wait): the deposit is handed back in store and recorded here.
 * Written as a NEW success row so the failed row stays on the ledger; only allowed when the newest row is a failed one.
 */
export const handBackDepositReturn = async (bookingID, { method, referenceNumber } = {}, issuedBy) => {
  const { payment, paymentID } = await loadPayment(bookingID);
  const methodKey = lower(method || "Cash").replace(/[\s-]+/g, "_").replace(/^banktransfer$/, "bank_transfer");
  if (!["cash", "gcash", "maya", "bank_transfer"].includes(methodKey)) throw new Error("Choose how the deposit was handed back.");

  const latest = await latestReturnRow(paymentID);
  if (!latest) throw new Error("There is no deposit return on this booking.");
  const st = lower(latest.status);
  if (st === "pending") throw new Error("PayMongo is still processing this deposit return. Wait for it to finish, or for it to fail, before handing it back in store.");
  if (st === "success") throw new Error("This deposit has already been returned.");

  const entryRef = db.collection(ENTRY_COLLECTION).doc();
  const amount = num(latest.amount);
  await db.runTransaction(async (tx) => {
    await assertNothingAlreadyReturned(tx, paymentID);
    const now = new Date();
    tx.set(entryRef, {
      paymentEntryID: entryRef.id, paymentID, bookingID, userID: payment.userID || null,
      refundReqID: null, penaltyID: null, direction: "out", phase: "deposit_return",
      source: "in_person", method: methodKey, amount, status: "success",
      referenceNumber: String(referenceNumber || "").trim() || null,
      sessionID: null, transactionFee: null, processedBy: issuedBy || null, processedAt: now, settledAt: now,
      groupID: null, transactionErrorNote: null, createdAt: now, updatedAt: now,
    });
  });

  await createTransactionLog({
    bookingID, paymentID, userID: payment.userID || null,
    type: "DepositReturn", amount, status: "Success",
    paymentMethod: method || "Cash", referenceNumber: String(referenceNumber || "").trim() || "", performedBy: issuedBy || null,
    description: "Security deposit handed back in store after the online return failed.",
    logID: `${paymentID}_deposit_settled`,
  }).catch((e) => console.error("[DEPOSIT RETURN] transaction log failed:", e.message));
  await resolveNotification("refund_due", bookingID).catch(() => {});
  auditSafe({ action: "update", userID: issuedBy || null, bookingID, paymentID,
    description: `Deposit of ${peso(amount)} for booking ${bookingID} handed back in store (${method || "Cash"}) after the online return failed.` });
  return { bookingID, amount };
};