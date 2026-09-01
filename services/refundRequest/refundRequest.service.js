import { db } from "../../config/firebaseConnection/firebase.js";
import { createTransactionLog } from "../transactionLogs/transactionLogs.service.js";
import { resolveNotification, createNotification } from "../notification/notification.service.js";

// Same PayMongo account as the customer backend — the secret key must be
// set in this backend's own env too (it's a separate deployment/process).
const PAYMONGO_SECRET = process.env.PAYMONGO_SECRET_KEY;
const PAYMONGO_V1 = "https://api.paymongo.com/v1";

const paymongoHeaders = () => ({
  "Content-Type": "application/json",
  "Authorization": `Basic ${Buffer.from(PAYMONGO_SECRET + ":").toString("base64")}`,
});

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

// ─────────────────────────────────────────────────────────────────────────────
// List refund requests, newest first. Optional status filter.
// ─────────────────────────────────────────────────────────────────────────────
export const getAllRefundRequests = async (status) => {
  let query = db.collection("refundRequests");
  if (status) query = query.where("status", "==", status);
  const snap = await query.get();

  const requests = await Promise.all(
    snap.docs.map(async (doc) => {
      const data = doc.data();
      const customerName = await resolveCustomerName(data.userID);
      return { ...data, customerName };
    })
  );

  requests.sort((a, b) => {
    const aT = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt);
    const bT = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt);
    return bT - aT;
  });

  return requests;
};

// ─────────────────────────────────────────────────────────────────────────────
// Approve a refund request:
//   1. Verify it's still Pending
//   2. Look up the payment's stored paymongoPaymentID
//   3. Call PayMongo POST /v1/refunds
//   4. Mark the request "Approved" and store the returned paymongoRefundID
//      (final "Refunded"/"Failed" status is set later by the customer
//      backend's refund.updated webhook, once PayMongo actually settles it)
// ─────────────────────────────────────────────────────────────────────────────
export const approveRefundRequest = async (refundRequestID, adminUserID) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);
  const reqSnap = await reqRef.get();

  if (!reqSnap.exists) {
    const err = new Error("Refund request not found.");
    err.status = 404;
    throw err;
  }

  const refundRequest = reqSnap.data();

  if (refundRequest.status !== "Pending") {
    const err = new Error(`Refund request is already ${refundRequest.status}.`);
    err.status = 409;
    throw err;
  }

  // Look up the payment to get its paymongoPaymentID (required by the
  // Refunds API — the checkout_session id will NOT work here).
  const paymentSnap = await db.collection("payments")
    .where("paymentID", "==", refundRequest.paymentID)
    .limit(1)
    .get();

  if (paymentSnap.empty) {
    const err = new Error("Underlying payment record not found.");
    err.status = 404;
    throw err;
  }

  const payment = paymentSnap.docs[0].data();

  if (!payment.paymongoPaymentID) {
    const err = new Error("This payment has no PayMongo payment id on file — cannot auto-refund.");
    err.status = 400;
    throw err;
  }

  const amountInCentavos = Math.round((refundRequest.amount || 0) * 100);

  let refundResponse;
  try {
    refundResponse = await fetch(`${PAYMONGO_V1}/refunds`, {
      method: "POST",
      headers: paymongoHeaders(),
      body: JSON.stringify({
        data: {
          attributes: {
            amount: amountInCentavos,
            payment_id: payment.paymongoPaymentID,
            reason: "requested_by_customer",
            notes: refundRequest.reason || undefined,
          },
        },
      }),
    });
  } catch (networkErr) {
    console.error("[REFUND] PayMongo request failed:", networkErr.message);
    const err = new Error("Could not reach PayMongo. Please try again.");
    err.status = 502;
    throw err;
  }

  const refundData = await refundResponse.json();

  if (!refundResponse.ok) {
    console.error("[REFUND] PayMongo rejected the refund:", refundData);
    const err = new Error(refundData?.errors?.[0]?.detail || "PayMongo rejected the refund.");
    err.status = 400;
    throw err;
  }

  const paymongoRefundID = refundData?.data?.id;
  const now = new Date();

  await reqRef.update({
    status: "Approved",
    paymongoRefundID,
    processedBy: adminUserID,
    processedAt: now,
    updatedAt: now,
  });

  // Resolved here directly rather than left to a Firestore watcher to
  // eventually notice — same reasoning as the customer backend now
  // writing the notification directly on creation: this admin backend
  // also runs as a Vercel serverless function, so a background
  // onSnapshot() listener isn't a reliable way to catch this reliably.
  resolveNotification("refund_request", refundRequestID)
    .catch((err) => console.error("[REFUND] Failed to resolve notification:", err.message));

  return { ...refundRequest, status: "Approved", paymongoRefundID };
};

// ─────────────────────────────────────────────────────────────────────────────
// Reject a refund request — purely local, never touches PayMongo.
// ─────────────────────────────────────────────────────────────────────────────
export const rejectRefundRequest = async (refundRequestID, adminUserID, rejectReason) => {
  const reqRef = db.collection("refundRequests").doc(refundRequestID);
  const reqSnap = await reqRef.get();

  if (!reqSnap.exists) {
    const err = new Error("Refund request not found.");
    err.status = 404;
    throw err;
  }

  const refundRequest = reqSnap.data();

  if (refundRequest.status !== "Pending") {
    const err = new Error(`Refund request is already ${refundRequest.status}.`);
    err.status = 409;
    throw err;
  }

  const now = new Date();
  await reqRef.update({
    status: "Rejected",
    rejectReason: rejectReason || null,
    processedBy: adminUserID,
    processedAt: now,
    updatedAt: now,
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
  });

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