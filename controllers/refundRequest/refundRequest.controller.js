import { getDiscountRefunds } from "../../services/payments/payments.service.js";
import { getDepositReturns } from "../../services/depositReturn/depositReturn.service.js";
import {
  getAllRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
  markManualRefundIssued,
  markFailedRefundHandedBack,
  retryScheduledRefund,
} from "../../services/refundRequest/refundRequest.service.js";
import { syncRefundsForBooking } from "../../services/refundRequest/refundSync.service.js";

export const listRefundRequests = async (req, res) => {
  try {
    const { status } = req.query; // optional ?status=Pending
    const data = await getAllRefundRequests(status);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REFUND] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Discounts that sent money back (or still have to), for the Refunds page's Under Process / History tabs.
export const listDiscountRefunds = async (req, res) => {
  try {
    const data = await getDiscountRefunds();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REFUND] discount refunds list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Deposit returns that went through PayMongo (or still wait on it), for the same Under Process / History tabs.
export const listDepositReturns = async (req, res) => {
  try {
    const data = await getDepositReturns();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REFUND] deposit returns list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const approveRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const adminUserID = req.user?.userID || req.user?.uid || null;
    // Optional staff override of the 48-hour deposit forfeit (goodwill, duplicate charge…).
    // A reason is mandatory — it is stored on the request and in the audit log.
    // `reason` is the staff's reason for the decision (optional note on approve; waiveReason is the old name for it).
    const { waiveForfeit, waiveReason, reason } = req.body || {};
    const data = await approveRefundRequest(id, adminUserID, { waiveForfeit: waiveForfeit === true, waiveReason, reason });
    return res.status(200).json({
      success: true,
      message: data.manualAmount > 0
        ? (data.scheduled
            ? "Refund approved. The payment was made today, so PayMongo can't send it yet: it is scheduled for the next day. Part of it must be handed back in person — mark it as returned once done. The booking has been cancelled."
            : "Refund approved and sent to PayMongo. Part of it must be handed back in person — mark it as returned once done. The booking has been cancelled.")
        : (data.scheduled
            ? "Refund approved. The payment was made today, so PayMongo can't send it yet: it is scheduled for the next day and will be sent automatically. The booking has been cancelled."
            : "Refund approved and sent to PayMongo. Final status will update once PayMongo confirms."),
      data,
    });
  } catch (error) {
    console.error("[REFUND] approve error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const rejectRefund = async (req, res) => {
  try {
    const { id } = req.params;
    // `reason` is the one field for the staff's reason; rejectReason is the old name and still accepted.
    const { reason, rejectReason } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await rejectRefundRequest(id, adminUserID, reason ?? rejectReason);
    return res.status(200).json({ success: true, message: "Refund request rejected.", data });
  } catch (error) {
    console.error("[REFUND] reject error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// PATCH /api/refund-requests/:id/manual-issued   { method: "Cash" | "GCash" | "Bank Transfer", referenceNumber?: string }
// Staff confirm they physically handed back the part PayMongo can't return.
export const manualRefundIssued = async (req, res) => {
  try {
    const { id } = req.params;
    const { method, referenceNumber } = req.body;
    const issuedBy = req.user?.userID || req.user?.uid || null;
    const data = await markManualRefundIssued(id, issuedBy, method || "Cash", referenceNumber);
    return res.status(200).json({
      success: true,
      message: data.refundCompleted ? "Marked as handed back. The refund is now complete." : "Marked as handed back. Waiting on PayMongo to settle the remaining part(s).",
      data,
    });
  } catch (error) {
    console.error("[REFUND] manual-issued error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// PATCH /api/refund-requests/:id/failed-handback   { method: "Cash" | "GCash" | "Maya" | "Bank Transfer", referenceNumber?: string }
// Staff paid back, themselves, the part(s) PayMongo refused on a Failed refund request.
export const failedRefundHandedBack = async (req, res) => {
  try {
    const { id } = req.params;
    const { method, referenceNumber } = req.body || {};
    const issuedBy = req.user?.userID || req.user?.uid || null;
    const data = await markFailedRefundHandedBack(id, issuedBy, method || "Cash", referenceNumber);
    return res.status(200).json({
      success: true,
      message: data.refundCompleted
        ? "Marked as handed back. The refund is now complete."
        : "Marked as handed back. The refund is still waiting on another part.",
      data,
    });
  } catch (error) {
    console.error("[REFUND] failed-handback error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// Staff "Retry now" on a scheduled refund that could not be sent.
export const retryScheduledRefundSend = async (req, res) => {
  try {
    const staffUserID = req.user?.userID || req.user?.uid || null;
    const data = await retryScheduledRefund(req.params.id, staffUserID);
    return res.status(200).json({ success: true, message: "Refund sent to PayMongo. Final status will update once PayMongo confirms.", data });
  } catch (error) {
    console.error("[REFUND] retry scheduled error:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};
// PATCH /api/refund-requests/booking/:bookingID/sync-paymongo
// Staff "Check with PayMongo": asks PayMongo for the final result of every refund of this booking that is still
// waiting (refund request, discount refund, deposit / discount return) and applies it, exactly as the webhook would.
export const syncBookingRefunds = async (req, res) => {
  try {
    const staffUserID = req.user?.userID || req.user?.uid || null;
    const data = await syncRefundsForBooking(req.params.bookingID, { actor: staffUserID });
    const message = data.completed || data.failed
      ? `Checked with PayMongo: ${data.completed} refund(s) confirmed${data.failed ? `, ${data.failed} reported as failed` : ""}.${data.stillPending ? ` ${data.stillPending} still processing at PayMongo.` : ""}`
      : data.stillPending
        ? "PayMongo is still processing this refund. Check again later."
        : "Nothing changed.";
    return res.status(200).json({ success: true, message, data });
  } catch (error) {
    console.error("[REFUND] sync error:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};