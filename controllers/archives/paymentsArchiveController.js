import {
  getAllPaymentsArchives,
} from "../../services/archives/paymentsArchives.service.js";
import { restoreArchiveItem, deleteArchiveItem, restoreMessage, deleteMessage } from "../../services/archives/archiveBundle.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listPaymentsArchives = async (req, res) => {
  try {
    const data = await getAllPaymentsArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restorePaymentsArchiveHandler = async (req, res) => {
  try {
    const { paymentsArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreArchiveItem("payments", paymentsArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived payment ${paymentsArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PAYMENTS ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: restoreMessage("payments", result),
      data: result,
    });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePaymentsArchiveHandler = async (req, res) => {
  try {
    const { paymentsArchivesId } = req.params;
    const result = await deleteArchiveItem("payments", paymentsArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived payment ${paymentsArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PAYMENTS ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: deleteMessage("payments", result), data: result });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};