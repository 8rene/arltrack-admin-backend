import {
  getAllRefundRequests,
  approveRefundRequest,
  rejectRefundRequest,
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
      message: "Refund approved and sent to PayMongo. Final status will update once PayMongo confirms.",
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
