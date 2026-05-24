import {
  getAllAuditLogsArchives,
  restoreAuditLogsArchive,
  deleteAuditLogsArchive,
} from "../../services/archives/auditLogsArchives.service.js";

export const listAuditLogsArchives = async (req, res) => {
  try {
    const data = await getAllAuditLogsArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[AUDIT LOGS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreAuditLogsArchiveHandler = async (req, res) => {
  try {
    const { auditLogsArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    await restoreAuditLogsArchive(auditLogsArchivesId, restoredBy);
    return res.status(200).json({ success: true, message: "Audit log restored successfully." });
  } catch (error) {
    console.error("[AUDIT LOGS ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteAuditLogsArchiveHandler = async (req, res) => {
  try {
    const { auditLogsArchivesId } = req.params;
    await deleteAuditLogsArchive(auditLogsArchivesId);
    return res.status(200).json({ success: true, message: "Archived audit log permanently deleted." });
  } catch (error) {
    console.error("[AUDIT LOGS ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
