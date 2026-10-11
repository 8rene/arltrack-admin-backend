import {
  getAllPenaltyArchives,
} from "../../services/archives/penaltyArchives.service.js";
import { restoreArchiveItem, deleteArchiveItem, restoreMessage, deleteMessage } from "../../services/archives/archiveBundle.service.js";
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
    const result = await restoreArchiveItem("penalties", penaltyArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived penalty ${penaltyArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PENALTY ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: restoreMessage("penalties", result),
      data: result,
    });
  } catch (error) {
    console.error("[PENALTY ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePenaltyArchiveHandler = async (req, res) => {
  try {
    const { penaltyArchivesId } = req.params;
    const result = await deleteArchiveItem("penalties", penaltyArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived penalty ${penaltyArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PENALTY ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: deleteMessage("penalties", result), data: result });
  } catch (error) {
    console.error("[PENALTY ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};