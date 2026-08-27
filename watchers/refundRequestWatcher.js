/**
 * refundRequestWatcher.js
 *
 * Refund requests were previously only surfaced on the Dashboard's Warning
 * panel — easy to miss if nobody happens to be on that specific page.
 * This gives them a real notification bell entry too, same pattern as
 * bookingWatcher.js's cancellation_request: create the moment a request
 * comes in as "Pending", auto-resolve the moment it leaves that status
 * (admin approved or rejected it).
 */

import { db } from "../config/firebaseConnection/firebase.js";
import { createNotification, resolveNotification } from "../services/notification/notification.service.js";

const PENDING_STATUS = "Pending"; // matches the exact casing used in refundRequest.service.js

export const startRefundRequestWatcher = () => {
  console.log("🔔 [RefundRequestWatcher] Watching refundRequests for status changes...");

  const lastStatus = new Map();

  db.collection("refundRequests").onSnapshot(async (snap) => {
    for (const change of snap.docChanges()) {
      const docID  = change.doc.id;
      const req    = change.doc.data();
      const status = req.status;

      if (change.type === "added") {
        lastStatus.set(docID, status);
        if (status === PENDING_STATUS) {
          await createNotification({
            type: "refund_request",
            refID: docID,
            refCollection: "refundRequests",
            title: "Refund request",
            message: `A refund request for ₱${Number(req.amount || 0).toLocaleString()} is awaiting review.`,
          });
        }
        continue;
      }

      if (change.type === "modified") {
        const prev = lastStatus.get(docID);
        lastStatus.set(docID, status);

        if (prev !== PENDING_STATUS && status === PENDING_STATUS) {
          // Re-entered Pending (shouldn't normally happen, but handle it)
          await createNotification({
            type: "refund_request",
            refID: docID,
            refCollection: "refundRequests",
            title: "Refund request",
            message: `A refund request for ₱${Number(req.amount || 0).toLocaleString()} is awaiting review.`,
          });
        } else if (prev === PENDING_STATUS && status !== PENDING_STATUS) {
          // Left Pending — approved or rejected, clear the bell
          await resolveNotification("refund_request", docID);
        }
      }

      if (change.type === "removed") {
        lastStatus.delete(docID);
        await resolveNotification("refund_request", docID);
      }
    }
  }, (err) => {
    console.error("[RefundRequestWatcher] Snapshot error:", err);
  });
};