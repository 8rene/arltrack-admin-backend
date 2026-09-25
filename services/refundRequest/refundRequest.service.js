import { db } from "../../config/firebaseConnection/firebase.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { resolveNotification, createNotification } from "../notification/notification.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";
import { computeRefundPlan } from "../payments/paymentBreakdown.js";
import { PAYMENT_METHODS } from "../payments/payments.service.js";
import { getSessionByBookingID, markSessionCancelled } from "../booking/bookingSession.service.js";
import { sendRefundEmail } from "../email/email.service.js";

// Same PayMongo account as the customer backend — the secret key must be
// set in this backend's own env too (it's a separate deployment/process).
const PAYMONGO_V1 = "https://api.paymongo.com/v1";

// Read at call time (not import time) so it works regardless of when dotenv loads.
const paymongoHeaders = () => ({
  "Content-Type": "application/json",
  "Authorization": `Basic ${Buffer.from((process.env.PAYMONGO_SECRET_KEY || "") + ":").toString("base64")}`,
});

const lower = (v) => String(v || "").toLowerCase();
const peso  = (n) => `₱${Number(n || 0).toLocaleString()}`;

// A second admin clicking Approve while the first is still talking to PayMongo
// would create a second set of refunds. The lock (a timestamp on the request,
// claimed in a transaction) makes that a clean 409. It expires so a crashed
// serverless invocation can never leave a request permanently stuck.
const APPROVAL_LOCK_MS = 2 * 60 * 1000;
const isLocked = (r) => {
  const at = r.approvalLockedAt?.toDate ? r.approvalLockedAt.toDate() : r.approvalLockedAt ? new Date(r.approvalLockedAt) : null;
  return !!at && Date.now() - at.getTime() < APPROVAL_LOCK_MS;
};

// resolve customer name for display — mirrors payments.service.js's helper
const resolveCustomerName = async (userID) => {
  if (!userID) return "—";
  try {
    const snap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!snap.empty) {
      const { firstName = "", lastName = "" } = snap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }
    const userDoc = await db.collection("user").doc(userID).get();
    if (userDoc.exists) {
      const { username = "", email = "" } = userDoc.data();
      return username || email || "—";
    }
    return "—";
  } catch { return "—"; }
};

const fail = (message, status) => { const err = new Error(message); err.status = status; return err; };

// ─────────────────────────────────────────────────────────────────────────────
// List refund requests, newest first. Optional status filter.
//
// Pending requests also carry a planPreview — what approving would do RIGHT NOW
// (recomputed from the payment as it stands today: the balance may have been
// paid or collected since the customer asked) — so staff see "₱2,500 via PayMongo
// + ₱2,501 to hand back in cash" before they click Approve.
// ─────────────────────────────────────────────────────────────────────────────
export const getAllRefundRequests = async (status) => {
  let query = db.collection("refundRequests");
  if (status) query = query.where("status", "==", status);
  const snap = await query.get();

  const requests = await Promise.all(
    snap.docs.map(async (doc) => {
      const data = doc.data();
      const customerName = await resolveCustomerName(data.userID);
      const row = { ...data, customerName };

      if (data.status === "Pending" && data.paymentID) {
        try {
          const pSnap = await db.collection("payments").where("paymentID", "==", data.paymentID).limit(1).get();
          if (!pSnap.empty) {
            const plan = computeRefundPlan(pSnap.docs[0].data());
            row.planPreview = {
              total: plan.total,
              onlineAmount: plan.total - plan.manualAmount,
              manualAmount: plan.manualAmount,
              parts: plan.parts.map((p) => ({ kind: p.kind, amount: p.amount })),
            };
          }
        } catch (e) { /* preview is best-effort */ }
      }
      return row;
    })
  );

  requests.sort((a, b) => {
    const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
    const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
    return bT - aT;
  });

  return requests;
};

// What refunding this booking right now would look like — same computation
// getAllRefundRequests() already does for a Pending request's planPreview,
// pulled out so the fleet status-change modal can show a real ₱ figure on
// each booking's Refund row before staff stage it. alreadyRefunded flags the
// data-mismatch case (payment says Refunded, booking never got cancelled to
// match) so the UI can show it distinctly instead of a confusing ₱0 button.
export const getBookingRefundPreview = async (bookingID) => {
  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (paymentSnap.empty) return { total: 0, onlineAmount: 0, manualAmount: 0, alreadyRefunded: false };
  const payment = paymentSnap.docs[0].data();
  if (lower(payment.status) === "refunded") {
    return { total: 0, onlineAmount: 0, manualAmount: 0, alreadyRefunded: true };
  }
  const plan = computeRefundPlan(payment);
  const outstandingDiscountRefund = payment.discountAmount > 0 && !payment.refundIssued ? plan.breakdown.refundDue : 0;
  const total = plan.total + outstandingDiscountRefund;
  return { total, onlineAmount: plan.total - plan.manualAmount, manualAmount: plan.manualAmount + outstandingDiscountRefund, alreadyRefunded: false };
};

// What actually happened the last time staff ran a refund/cancel against
// this booking — used by getResolvedBookingsForCar() (services/fleet/
// fleet.service.js) to label a booking in the "Already resolved" section.
// Every staffRefundBooking()/staffCancelWithNoRefund() outcome writes a
// refundRequests doc (source: "staff"), even the two where no money moved,
// specifically so this lookup always has something to find.
export const getStaffRefundOutcome = async (bookingID) => {
  // Two equality filters, no orderBy — avoids needing a composite Firestore
  // index. In practice there's only ever one of these per booking (once
  // resolved, the booking's "cancelled" and this never runs again for it),
  // but sort in memory just in case there's somehow more than one.
  const snap = await db.collection("refundRequests")
    .where("bookingID", "==", bookingID)
    .where("source", "==", "staff")
    .get();
  if (snap.empty) return { outcome: null, amount: 0 };
  const docs = snap.docs.map((d) => d.data());
  docs.sort((a, b) => {
    const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
    const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
    return bT - aT;
  });
  return { outcome: docs[0].outcome || null, amount: docs[0].amount || 0 };
};

// One PayMongo refund against one payment. Returns the PayMongo refund id.
const createPaymongoRefund = async ({ paymongoPaymentID, amount, reason }) => {
  let response;
  try {
    response = await fetch(`${PAYMONGO_V1}/refunds`, {
      method: "POST",
      headers: paymongoHeaders(),
      body: JSON.stringify({
        data: {
          attributes: {
            amount: Math.round((amount || 0) * 100),
            payment_id: paymongoPaymentID,
            reason: "requested_by_customer",
            notes: reason || undefined,
          },
        },
      }),
    });
  } catch (networkErr) {
    console.error("[REFUND] PayMongo request failed:", networkErr.message);
    throw fail("Could not reach PayMongo. Please try again.", 502);
  }

  const data = await response.json();
  if (!response.ok) {
    console.error("[REFUND] PayMongo rejected the refund:", data);
    throw fail(data?.errors?.[0]?.detail || "PayMongo rejected the refund.", 400);
  }
  const id = data?.data?.id;
  if (!id) throw fail("PayMongo accepted the refund but returned no refund id.", 502);
  return id;
};

// Cancels the booking a refund was approved for. Only bookings that haven't
// started ("to pay"/"upcoming"): an ongoing/completed trip is never silently
// cancelled by a refund. Same two writes the admin's own cancel does (status +
// bookingSession). Returns { cancelled, driverID }.
const cancelBookingForRefund = async (bookingID, reason) => {
  if (!bookingID) return { cancelled: false, driverID: null };
  let ref = db.collection("bookings").doc(bookingID);
  let snap = await ref.get();
  if (!snap.exists) {
    const q = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    if (q.empty) return { cancelled: false, driverID: null };
    ref = q.docs[0].ref; snap = q.docs[0];
  }
  const b = snap.data();
  if (!["to pay", "upcoming"].includes(lower(b.status))) {
    return { cancelled: false, driverID: b.driverID || null, status: b.status };
  }
  await ref.update({ status: "cancelled", cancellationReason: reason, updatedAt: new Date() });
  try {
    const session = await getSessionByBookingID(bookingID);
    if (session) await markSessionCancelled(session.ref.id);
  } catch (err) {
    console.error("[REFUND] failed to sync bookingSession on cancel:", err.message);
  }
  return { cancelled: true, driverID: b.driverID || null };
};

const notifyCustomer = (userID, bookingID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: bookingID || null, refCollection: "bookings", title, message, userID })
    .catch((err) => console.error(`[REFUND] failed to notify customer (${type}):`, err.message));
};

// resolve customer email + display name for the refund email — mirrors
// resolveCustomerName's fallback chain (userDetails first/last name, then
// the "user" collection doc), since the email only lives on the latter.
const resolveCustomerContact = async (userID) => {
  if (!userID) return { email: null, name: "—" };
  try {
    let name = "—";
    const detailsSnap = await db.collection("userDetails").where("userID", "==", userID).limit(1).get();
    if (!detailsSnap.empty) {
      const { firstName = "", lastName = "" } = detailsSnap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) name = fullName;
    }
    const userDoc = await db.collection("user").doc(userID).get();
    if (!userDoc.exists) return { email: null, name };
    const { email = null, username = "" } = userDoc.data();
    if (name === "—") name = username || email || "—";
    return { email, name };
  } catch {
    return { email: null, name: "—" };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Approve a refund request.
//
//   1. Claim the request (Pending only, one admin at a time).
//   2. Recompute the plan from the payment AS IT STANDS NOW — everything the
//      customer has paid, split into:
//        parts[]       one PayMongo refund per online charge (PayMongo can only
//                      return up to what it received on each payment_id)
//        manualAmount  what PayMongo can't return — balance staff collected in
//                      person, a cash deposit, or a charge whose id is unknown.
//                      Staff hand it back and mark it issued (markManualRefundIssued).
//   3. Create the PayMongo refunds.
//   4. Mark the request "Approved", cancel the booking, tell the customer.
//
// "Refunded" (and the payment flipping to Refunded) happens LATER: when every
// PayMongo part has settled (customer backend's refund webhook) AND any manual
// portion is marked issued.
// ─────────────────────────────────────────────────────────────────────────────
export const approveRefundRequest = async (refundRequestID, adminUserID) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  // ── 1. claim ──
  const refundRequest = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Pending") throw fail(`Refund request is already ${r.status}.`, 409);
    if (isLocked(r)) throw fail("This refund is already being processed by another admin. Refresh in a moment.", 409);
    t.update(reqRef, { approvalLockedAt: new Date() });
    return r;
  });
  const releaseLock = () => reqRef.update({ approvalLockedAt: null }).catch(() => {});

  try {
    // ── 2. the plan, from the payment as it is now ──
    const paymentSnap = await db.collection("payments").where("paymentID", "==", refundRequest.paymentID).limit(1).get();
    if (paymentSnap.empty) throw fail("Underlying payment record not found.", 404);
    const payment = paymentSnap.docs[0].data();

    const payStatus = lower(payment.status);
    if (payStatus === "refunded") throw fail("This payment has already been refunded.", 409);
    if (!["paid", "approved"].includes(payStatus)) throw fail(`This payment is "${payment.status}" — only a paid payment can be refunded.`, 400);

    const plan = computeRefundPlan(payment);
    if (plan.total <= 0) throw fail("There is nothing to refund on this payment.", 400);

    // ── 3. PayMongo refunds, one per online charge ──
    const parts = [];
    for (const part of plan.parts) {
      try {
        const paymongoRefundID = await createPaymongoRefund({
          paymongoPaymentID: part.paymongoPaymentID,
          amount: part.amount,
          reason: refundRequest.reason,
        });
        parts.push({ kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID, status: "pending" });
      } catch (e) {
        if (parts.length === 0) throw e; // nothing went out — request stays Pending, staff can just retry
        // An earlier part is ALREADY refunded at PayMongo and can't be rolled
        // back. Record exactly what happened so it isn't lost, and mark the
        // request Failed so staff finish it by hand instead of it looking untouched.
        const failedAt = new Date();
        await reqRef.update({
          status: "Failed",
          parts: [...parts, { kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID: null, status: "failed", error: e.message }],
          paymongoRefundID: parts[0].paymongoRefundID,
          paymongoRefundIDs: parts.map((p) => p.paymongoRefundID),
          processedBy: adminUserID,
          processedAt: failedAt,
          updatedAt: failedAt,
          approvalLockedAt: null,
        });
        auditSafe({
          action: "update",
          description: `Refund ${refundRequestID}: the ${part.kind} refund failed at PayMongo (${e.message}) AFTER ${parts.length} earlier part(s) had already been refunded — needs manual follow-up.`,
          userID: adminUserID,
          bookingID: refundRequest.bookingID,
          paymentID: refundRequest.paymentID,
          refundRequestID,
        });
        throw fail(`Part of the refund went through at PayMongo, but the ${part.kind} refund failed: ${e.message}. The request is marked Failed — please finish the remainder manually.`, 502);
      }
    }

    // ── 4. approved ──
    const onlineAmount = plan.total - plan.manualAmount;
    const manualRefund = plan.manualAmount > 0
      ? { amount: plan.manualAmount, issued: false, issuedBy: null, issuedAt: null, method: null }
      : null;
    const now = new Date();

    await reqRef.update({
      status: "Approved",
      amount: plan.total,
      onlineAmount,
      manualAmount: plan.manualAmount,
      parts,
      paymongoRefundID: parts[0]?.paymongoRefundID || null,      // legacy single-id field
      paymongoRefundIDs: parts.map((p) => p.paymongoRefundID),   // webhook lookup key
      manualRefund,
      processedBy: adminUserID,
      processedAt: now,
      updatedAt: now,
      customerNotified: true, // told right now, below — the daily cron only covers what this misses
      approvalLockedAt: null,
    });

    // Decision: the booking is cancelled at APPROVAL. Staff have decided this trip
    // isn't happening, so the car is released straight away; a PayMongo hiccup is
    // a technical retry, not a reason to keep the trip alive.
    const cancel = await cancelBookingForRefund(refundRequest.bookingID, "Cancelled: refund approved.");

    await notifyCustomer(
      refundRequest.userID, refundRequest.bookingID, "refund_approved", "Refund Approved",
      manualRefund
        ? `Your refund of ${peso(plan.total)} has been approved. ${peso(onlineAmount)} is being returned through PayMongo and ${peso(plan.manualAmount)} will be handed back to you by our staff.`
        : `Your refund of ${peso(plan.total)} has been approved and is being processed by PayMongo.`
    );

    // A driver already assigned to this booking shouldn't find out secondhand.
    if (cancel.cancelled && cancel.driverID) {
      createNotification({
        type: "refund_request", refID: refundRequestID, refCollection: "refundRequests",
        title: "Booking cancelled — refund approved",
        message: `A booking you were assigned to (${refundRequest.bookingID}) was cancelled because its refund was approved.`,
        userID: cancel.driverID,
      }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
    }

    auditSafe({
      action: "update",
      description: `Refund ${refundRequestID} APPROVED for ${peso(plan.total)} (${peso(onlineAmount)} via PayMongo in ${parts.length} refund(s)${manualRefund ? `, ${peso(plan.manualAmount)} to hand back manually` : ""}). Booking ${refundRequest.bookingID}: ${cancel.cancelled ? "cancelled" : `left as ${cancel.status || "unchanged"}`}.`,
      userID: adminUserID,
      bookingID: refundRequest.bookingID,
      paymentID: refundRequest.paymentID,
      refundRequestID,
    });

    // Resolved here directly rather than left to a Firestore watcher — this backend
    // runs as a Vercel serverless function, so a background listener isn't reliable.
    resolveNotification("refund_request", refundRequestID)
      .catch((err) => console.error("[REFUND] Failed to resolve notification:", err.message));

    return { ...refundRequest, status: "Approved", amount: plan.total, onlineAmount, manualAmount: plan.manualAmount, parts, manualRefund, bookingCancelled: cancel.cancelled };
  } catch (err) {
    await releaseLock(); // safe even if an update above already cleared it
    throw err;
  }
};

// Cancels a booking with nothing left to actually refund — either its
// payment was already refunded earlier (a data mismatch: the payment side
// finished but the booking never got cancelled to match — this is what
// Fleet.jsx's status-change flow runs into and surfaces), or genuinely
// nothing was ever collected. Same cancel + bell notification either way,
// just no PayMongo call, no email (nothing happened to their money worth
// emailing about), and no transaction log (that ledger is money-movement
// only — the audit log below is what records this instead).
const staffCancelWithNoRefund = async (bookingID, booking, payment, reason, staffUserID, outcome) => {
  const userID = payment?.userID || booking.userID || null;
  const now = new Date();

  // Written even though nothing's actually being refunded — this is the one
  // place the "Already resolved" list (getResolvedBookingsForCar) looks up
  // what happened to a booking, so every outcome needs a record here to be
  // found later, not just the ones where real money moved.
  const refundRequestRef = db.collection("refundRequests").doc();
  await refundRequestRef.set({
    refundRequestID: refundRequestRef.id,
    bookingID,
    paymentID: payment?.paymentID || null,
    userID,
    reason,
    notes: outcome === "already_refunded"
      ? "Staff-initiated: payment was already refunded earlier; booking cancelled to match."
      : "Staff-initiated: nothing had been paid; booking cancelled, no refund needed.",
    source: "staff",
    outcome,
    amount: 0,
    onlineAmount: 0,
    manualAmount: 0,
    parts: [],
    manualRefund: null,
    status: "Refunded", // nothing left to do — no manual portion to issue later
    processedBy: staffUserID,
    processedAt: now,
    customerNotified: true,
    createdAt: now,
    updatedAt: now,
  });

  const cancel = await cancelBookingForRefund(bookingID, `Cancelled by staff: ${reason}`);

  await notifyCustomer(
    userID, bookingID, "refund_approved", "Booking Cancelled",
    outcome === "already_refunded"
      ? `Your booking was cancelled: ${reason}. This booking's payment had already been refunded, so no new refund was needed.`
      : `Your booking was cancelled: ${reason}.`
  );

  if (cancel.driverID) {
    createNotification({
      type: "refund_request", refID: bookingID, refCollection: "bookings",
      title: "Booking cancelled",
      message: `A booking you were assigned to (${bookingID}) was cancelled by staff: ${reason}.`,
      userID: cancel.driverID,
    }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
  }

  auditSafe({
    action: "update",
    description: outcome === "already_refunded"
      ? `Booking ${bookingID} cancelled — its payment was already refunded earlier but the booking itself hadn't been. Car status change: ${reason}.`
      : `Booking ${bookingID} cancelled — nothing had been paid, so nothing to refund. Car status change: ${reason}.`,
    userID: staffUserID,
    bookingID,
    paymentID: payment?.paymentID || null,
  });

  return { outcome, bookingID, amount: 0, manualAmount: 0, bookingCancelled: cancel.cancelled };
};

// ─────────────────────────────────────────────────────────────────────────────
// Staff-initiated refund for ONE booking — used when a car is being switched
// to Maintenance/Inactive and has an upcoming booking sitting on it (see
// Fleet.jsx's status-change flow, which calls this in a loop, one booking at
// a time, stopping at the first failure — see changeCarStatus()). Unlike
// approveRefundRequest() above, there's no customer-submitted request behind
// this: staff are the ones forcing the cancellation, so this creates the
// refundRequests record AND resolves it in the same call, starting straight
// at "Approved" — there's no review step to sit in "Pending" for. This is
// the one deliberate exception to refundRequest.model.js's "admin never
// creates" note; the doc it writes carries source: "staff" so it's easy to
// tell apart from a customer-submitted one in the Refund Requests list.
//
// Returns { outcome, bookingID, amount, manualAmount, bookingCancelled }.
// outcome is one of:
//   "refunded"        — real money moved (PayMongo and/or a manual/cash
//                        portion still to be handed back in person)
//   "already_refunded"— the payment was already Refunded but the booking
//                        wasn't cancelled to match; just closes that gap
//   "nothing_owed"     — genuinely nothing had been collected; cancel only
// Only "refunded" sends the customer an email and writes a transactionLogs
// entry — the other two are anomalies (see notes in Fleet.jsx), not real
// money movement, so they're bell + audit log only.
//
// Always a FULL refund of whatever's been collected — no cancellation fee,
// since this is the business forcing the cancellation, not the customer's
// choice — and that includes any outstanding discount spillover the
// customer is still separately owed (see applyDiscount()'s refundDue) that
// hadn't been handed back yet; that gets folded into the manual amount here
// and the payment's refundIssued flag gets set so the old discount-
// correction page doesn't also try to pay it out later.
//
// Only ever called for an "upcoming" booking (never "ongoing" — the car's
// already with the customer by then, and cancelBookingForRefund() below
// won't cancel anything past "upcoming" anyway).
// ─────────────────────────────────────────────────────────────────────────────
export const staffRefundBooking = async (bookingID, reason, staffUserID) => {
  if (!bookingID) throw fail("bookingID is required.", 400);
  if (!reason || !reason.trim()) throw fail("A reason is required.", 400);

  const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  if (bookingSnap.empty) throw fail("Booking not found.", 404);
  const booking = bookingSnap.docs[0].data();
  if (lower(booking.status) !== "upcoming") {
    throw fail(`This booking is "${booking.status}", not upcoming — it can't be refunded through this flow.`, 409);
  }

  const paymentSnap = await db.collection("payments").where("bookingID", "==", bookingID).limit(1).get();
  if (paymentSnap.empty) throw fail("No payment record found for this booking.", 404);
  const paymentRef = paymentSnap.docs[0].ref;
  const payment = paymentSnap.docs[0].data();
  const payStatus = lower(payment.status);

  // Data mismatch: payment's already Refunded, booking never got cancelled
  // to match. Nothing left to refund — just close the booking out.
  if (payStatus === "refunded") {
    return staffCancelWithNoRefund(bookingID, booking, payment, reason, staffUserID, "already_refunded");
  }

  const userID = payment.userID || booking.userID || null;
  const plan = computeRefundPlan(payment);
  const outstandingDiscountRefund = payment.discountAmount > 0 && !payment.refundIssued ? plan.breakdown.refundDue : 0;
  const totalToRefund = plan.total + outstandingDiscountRefund;

  // Genuinely nothing collected (still Pending, etc.) — cancel only.
  if (totalToRefund === 0) {
    return staffCancelWithNoRefund(bookingID, booking, payment, reason, staffUserID, "nothing_owed");
  }

  if (!["paid", "approved"].includes(payStatus)) {
    throw fail(`This payment is "${payment.status}" with ${peso(totalToRefund)} apparently owed — needs manual review before this can be refunded automatically.`, 409);
  }

  const now = new Date();
  const refundRequestRef = db.collection("refundRequests").doc();
  const refundRequestID = refundRequestRef.id;

  let parts = [];
  for (const part of plan.parts) {
    try {
      const paymongoRefundID = await createPaymongoRefund({
        paymongoPaymentID: part.paymongoPaymentID,
        amount: part.amount,
        reason,
      });
      parts.push({ kind: part.kind, paymongoPaymentID: part.paymongoPaymentID, amount: part.amount, paymongoRefundID, status: "pending" });
    } catch (e) {
      // Nothing (or only an earlier part) went out — safe to just fail
      // the whole thing here rather than leave a half-written record,
      // since (unlike approveRefundRequest) there's no existing Pending
      // doc a retry needs to find its way back to.
      auditSafe({
        action: "update",
        description: `Staff refund for booking ${bookingID} failed at PayMongo for the ${part.kind} part (${e.message})${parts.length > 0 ? ` after ${parts.length} earlier part(s) already went through — needs manual follow-up` : ""}.`,
        userID: staffUserID,
        bookingID,
        paymentID: payment.paymentID,
      });
      throw fail(
        parts.length > 0
          ? `Part of the refund went through at PayMongo, but the ${part.kind} refund failed: ${e.message}. Please finish this one manually from the Refund Requests page.`
          : `Refund failed: ${e.message}`,
        502
      );
    }
  }

  const onlineAmount = plan.total - plan.manualAmount;
  // The cash/manual bucket now also carries any outstanding discount
  // spillover, since PayMongo has no way to return that part either.
  const manualAmount = plan.manualAmount + outstandingDiscountRefund;
  const manualRefund = manualAmount > 0
    ? { amount: manualAmount, issued: false, issuedBy: null, issuedAt: null, method: null }
    : null;

  await refundRequestRef.set({
    refundRequestID,
    bookingID,
    paymentID: payment.paymentID,
    userID,
    reason,
    notes: "Staff-initiated: car marked Maintenance/Inactive with an upcoming booking on it.",
    source: "staff",
    outcome: "refunded",
    amount: totalToRefund,
    onlineAmount,
    manualAmount,
    parts,
    paymongoRefundID: parts[0]?.paymongoRefundID || null,
    paymongoRefundIDs: parts.map((p) => p.paymongoRefundID),
    manualRefund,
    status: "Approved",
    processedBy: staffUserID,
    processedAt: now,
    customerNotified: true,
    createdAt: now,
    updatedAt: now,
  });

  // Resolve any outstanding discount spillover now that it's folded into
  // this refund, so correctIssuedDiscount() doesn't also try to pay it.
  await paymentRef.update({
    updatedAt: now,
    ...(outstandingDiscountRefund > 0 ? { refundIssued: true } : {}),
  });

  const cancel = await cancelBookingForRefund(bookingID, `Cancelled by staff: ${reason}`);

  const { email: customerEmail, name: customerName } = await resolveCustomerContact(userID);

  await notifyCustomer(
    userID, bookingID, "refund_approved", "Booking Cancelled — Refund Processed",
    manualRefund
      ? `Your booking was cancelled: ${reason}. ${peso(onlineAmount)} is being returned through PayMongo and ${peso(manualAmount)} will be handed back to you by our staff.`
      : `Your booking was cancelled: ${reason}. Your payment of ${peso(totalToRefund)} is being refunded through PayMongo.`
  );

  if (customerEmail) {
    sendRefundEmail({
      toEmail: customerEmail,
      toName: customerName,
      bookingID,
      amount: totalToRefund,
      manualAmount,
      reason,
    }).catch((err) => console.error("[REFUND] staff refund email failed:", err.message));
  }

  if (cancel.driverID) {
    createNotification({
      type: "refund_request", refID: refundRequestID, refCollection: "refundRequests",
      title: "Booking cancelled",
      message: `A booking you were assigned to (${bookingID}) was cancelled by staff: ${reason}.`,
      userID: cancel.driverID,
    }).catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
  }

  createTransactionLog({
    bookingID,
    paymentID: payment.paymentID,
    refundRequestID,
    userID,
    type: "Refund",
    amount: totalToRefund,
    status: "Refunded",
    description: `${peso(totalToRefund)} refunded for booking ${bookingID} — staff cancelled it while changing the car's status: ${reason}.`,
    performedBy: staffUserID,
    logID: `${refundRequestID}_staff`,
  });

  auditSafe({
    action: "update",
    description: `Refund ${refundRequestID}: booking ${bookingID} cancelled and ${peso(totalToRefund)} refunded — car status change: ${reason}.`,
    userID: staffUserID,
    bookingID,
    paymentID: payment.paymentID,
    refundRequestID,
  });

  return {
    outcome: "refunded",
    bookingID,
    amount: totalToRefund,
    onlineAmount,
    manualAmount,
    manualRefund,
    bookingCancelled: cancel.cancelled,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Staff confirm they physically handed back the part PayMongo can't return
// (balance collected in person, a cash deposit, …). This is what lets a request
// reach "Refunded" when it has a manual portion.
// ─────────────────────────────────────────────────────────────────────────────
export const markManualRefundIssued = async (refundRequestID, issuedBy, method = "Cash") => {
  if (!PAYMENT_METHODS.includes(method)) {
    throw fail(`method must be one of: ${PAYMENT_METHODS.join(", ")}.`, 400);
  }
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  const outcome = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Approved") throw fail(`Only an Approved refund can be marked as handed back (this one is ${r.status}).`, 409);
    if (!r.manualRefund || !(Number(r.manualRefund.amount) > 0)) throw fail("This refund has no manual portion to hand back.", 400);
    if (r.manualRefund.issued) throw fail("This has already been marked as handed back.", 409);

    const now = new Date();
    const manualRefund = { ...r.manualRefund, issued: true, issuedBy: issuedBy || null, issuedAt: now, method };
    const parts = Array.isArray(r.parts) ? r.parts : [];
    // Finished only if every PayMongo part has already settled. Otherwise the
    // customer-backend webhook completes it when the last part lands.
    const finalize = parts.every((p) => p.status === "succeeded");
    t.update(reqRef, { manualRefund, updatedAt: now, ...(finalize ? { status: "Refunded" } : {}) });
    return { request: { ...r, manualRefund, status: finalize ? "Refunded" : r.status }, finalize };
  });

  const r = outcome.request;

  createTransactionLog({
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundRequestID,
    userID: r.userID,
    type: "Refund",
    amount: r.manualRefund.amount,
    status: "Refunded",
    paymentMethod: method,
    description: `${peso(r.manualRefund.amount)} handed back to the customer in person (the part PayMongo couldn't return) for booking ${r.bookingID}.`,
    performedBy: issuedBy || "—",
    logID: `${refundRequestID}_manual`,
  });

  auditSafe({
    action: "update",
    description: `Refund ${refundRequestID}: ${peso(r.manualRefund.amount)} marked as handed back to the customer via ${method}.${outcome.finalize ? " Refund complete." : " Waiting on PayMongo to settle the remaining part(s)."}`,
    userID: issuedBy || null,
    bookingID: r.bookingID,
    paymentID: r.paymentID,
    refundRequestID,
  });

  if (outcome.finalize) {
    const now = new Date();
    if (r.paymentID) {
      const pSnap = await db.collection("payments").where("paymentID", "==", r.paymentID).limit(1).get();
      if (!pSnap.empty) await pSnap.docs[0].ref.update({ status: "Refunded", refundedAt: now, updatedAt: now });
    }
    await notifyCustomer(r.userID, r.bookingID, "refund_completed", "Refund Completed", `Your refund of ${peso(r.amount)} has been returned.`);
  }

  return { ...r, refundCompleted: outcome.finalize };
};

// ─────────────────────────────────────────────────────────────────────────────
// Reject a refund request — purely local, never touches PayMongo, and leaves
// the booking and payment exactly as they were.
// ─────────────────────────────────────────────────────────────────────────────
export const rejectRefundRequest = async (refundRequestID, adminUserID, rejectReason) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);

  const refundRequest = await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) throw fail("Refund request not found.", 404);
    const r = snap.data();
    if (r.status !== "Pending") throw fail(`Refund request is already ${r.status}.`, 409);
    // Approval keeps the status "Pending" while it talks to PayMongo, so without this
    // a reject could slip in mid-approval — and the approval would then overwrite it
    // AFTER the money had already gone out.
    if (isLocked(r)) throw fail("This refund is being approved right now. Refresh in a moment.", 409);
    const now = new Date();
    t.update(reqRef, {
      status: "Rejected",
      rejectReason: rejectReason || null,
      processedBy: adminUserID,
      processedAt: now,
      updatedAt: now,
      customerNotified: true, // told right now, below
    });
    return r;
  });

  createTransactionLog({
    bookingID: refundRequest.bookingID,
    paymentID: refundRequest.paymentID,
    refundRequestID,
    userID: refundRequest.userID,
    type: "Refund",
    amount: refundRequest.amount || 0,
    status: "Rejected",
    description: rejectReason
      ? `Refund request rejected: ${rejectReason}`
      : `Refund request rejected.`,
    performedBy: adminUserID,
    logID: `${refundRequestID}_rejected`,
  });

  auditSafe({
    action: "update",
    description: `Refund ${refundRequestID} REJECTED (${peso(refundRequest.amount)})${rejectReason ? `: ${rejectReason}` : ""}.`,
    userID: adminUserID,
    bookingID: refundRequest.bookingID,
    paymentID: refundRequest.paymentID,
    refundRequestID,
  });

  await notifyCustomer(
    refundRequest.userID, refundRequest.bookingID, "refund_rejected", "Refund Rejected",
    rejectReason ? `Your refund request was rejected: ${rejectReason}` : "Your refund request was rejected."
  );

  resolveNotification("refund_request", refundRequestID)
    .catch((err) => console.error("[REFUND] Failed to resolve notification:", err.message));

  // If this booking has a driver assigned, let them know the refund tied
  // to it was rejected — they may be mid-handling something related
  // (e.g. holding cash, coordinating with the customer) and shouldn't
  // find out secondhand.
  if (refundRequest.bookingID) {
    db.collection("bookings").doc(refundRequest.bookingID).get()
      .then((bookingSnap) => {
        const driverID = bookingSnap.exists ? bookingSnap.data().driverID : null;
        if (!driverID) return;
        return createNotification({
          type: "refund_request",
          refID: refundRequestID,
          refCollection: "refundRequests",
          title: "Refund request rejected",
          message: rejectReason
            ? `The refund request for your booking was rejected: ${rejectReason}`
            : `The refund request for your booking was rejected.`,
          userID: driverID,
        });
      })
      .catch((err) => console.error("[REFUND] Failed to notify assigned driver:", err.message));
  }

  return { ...refundRequest, status: "Rejected", rejectReason: rejectReason || null };
};