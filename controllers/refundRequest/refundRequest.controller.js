import {
  getAllRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
  markManualRefundIssued,
} from "../../services/refundRequest/refundRequest.service.js";

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
        ? "Refund approved and sent to PayMongo. Part of it must be handed back in person — mark it as returned once done. The booking has been cancelled."
        : "Refund approved and sent to PayMongo. Final status will update once PayMongo confirms.",
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

// PATCH /api/refund-requests/:id/manual-issued   { method: "Cash" | "GCash" | "Bank Transfer" }
// Staff confirm they physically handed back the part PayMongo can't return.
export const manualRefundIssued = async (req, res) => {
  try {
    const { id } = req.params;
    const { method } = req.body;
    const issuedBy = req.user?.userID || req.user?.uid || null;
    const data = await markManualRefundIssued(id, issuedBy, method || "Cash");
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