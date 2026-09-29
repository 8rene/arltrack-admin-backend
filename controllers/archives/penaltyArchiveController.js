import {
  getAllPenaltyArchives,
  restorePenaltyArchive,
  deletePenaltyArchive,
} from "../../services/archives/penaltyArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listPenaltyArchives = async (req, res) => {
  try {
    const data = await getAllPenaltyArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PENALTY ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restorePenaltyArchiveHandler = async (req, res) => {
  try {
    const { penaltyArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restorePenaltyArchive(penaltyArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived penalty ${penaltyArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PENALTY ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: `Penalty restored successfully.${result.restoredBooking ? " Linked booking also restored." : ""}${result.restoredPayment ? " Linked payment also restored." : ""}`,
    });
  } catch (error) {
    console.error("[PENALTY ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePenaltyArchiveHandler = async (req, res) => {
  try {
    const { penaltyArchivesId } = req.params;
    await deletePenaltyArchive(penaltyArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived penalty ${penaltyArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PENALTY ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived penalty permanently deleted." });
  } catch (error) {
    console.error("[PENALTY ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};