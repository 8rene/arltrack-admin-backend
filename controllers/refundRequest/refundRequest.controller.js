import {
  getAllRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
  markManualRefundIssued,
  staffRefundBooking,
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
    const data = await approveRefundRequest(id, adminUserID);
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
    const { rejectReason } = req.body;
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await rejectRefundRequest(id, adminUserID, rejectReason);
    return res.status(200).json({ success: true, message: "Refund request rejected.", data });
  } catch (error) {
    console.error("[REFUND] reject error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// POST /api/refund-requests/staff-refund/:bookingID   { reason }
// Staff force-cancelling + refunding one upcoming booking, e.g. while
// switching its car to Maintenance/Inactive — see Fleet.jsx's status-change
// flow and staffRefundBooking() for the full picture.
export const staffRefund = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const { reason } = req.body;
    const staffUserID = req.user?.userID || req.user?.uid || null;
    const data = await staffRefundBooking(bookingID, reason, staffUserID);
    return res.status(200).json({
      success: true,
      message: data.manualRefund
        ? `Booking cancelled. ${data.onlineAmount ? "Part of the refund is" : "The refund is"} being processed by PayMongo — the remaining manual portion needs to be handed back and marked as returned from the Refund Requests page.`
        : "Booking cancelled and refunded.",
      data,
    });
  } catch (error) {
    console.error("[REFUND] staffRefund error:", error);
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