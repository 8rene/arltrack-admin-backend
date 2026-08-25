import {
  getAllSessionLogArchives,
  restoreSessionLogArchive,
  deleteSessionLogArchive,
} from "../../services/archives/sessionLogArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listSessionLogArchives = async (req, res) => {
  try {
    const data = await getAllSessionLogArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SESSION LOG ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreSessionLogArchiveHandler = async (req, res) => {
  try {
    const { sessionLogArchivesId } = req.params;
    await restoreSessionLogArchive(sessionLogArchivesId);
    createAuditLog({
      action: "update",
      description: `Restored archived session log ${sessionLogArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[SESSION LOG ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Session log restored successfully." });
  } catch (error) {
    console.error("[SESSION LOG ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteSessionLogArchiveHandler = async (req, res) => {
  try {
    const { sessionLogArchivesId } = req.params;
    await deleteSessionLogArchive(sessionLogArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived session log ${sessionLogArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[SESSION LOG ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived session log permanently deleted." });
  } catch (error) {
    console.error("[SESSION LOG ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};