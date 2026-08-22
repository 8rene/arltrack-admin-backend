import {
  getAllRefundArchives,
  restoreRefundArchive,
  deleteRefundArchive,
} from "../../services/archives/refundArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listRefundArchives = async (req, res) => {
  try {
    const data = await getAllRefundArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REFUND ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreRefundArchiveHandler = async (req, res) => {
  try {
    const { refundArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreRefundArchive(refundArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived refund request ${refundArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[REFUND ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: `Refund request restored successfully.${result.restoredBooking ? " Linked booking also restored." : ""}${result.restoredPayment ? " Linked payment also restored." : ""}`,
    });
  } catch (error) {
    console.error("[REFUND ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteRefundArchiveHandler = async (req, res) => {
  try {
    const { refundArchivesId } = req.params;
    await deleteRefundArchive(refundArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived refund request ${refundArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[REFUND ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived refund request permanently deleted." });
  } catch (error) {
    console.error("[REFUND ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};