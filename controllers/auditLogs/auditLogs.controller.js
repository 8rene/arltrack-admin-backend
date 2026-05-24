import { getAllAuditLogs, archiveAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listAuditLogs = async (req, res) => {
  try {
    const data = await getAllAuditLogs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[AUDIT LOGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteAuditLog = async (req, res) => {
  try {
    const { id } = req.params;
    await archiveAuditLog(id);
    return res.status(200).json({ success: true, message: "Audit log archived successfully." });
  } catch (error) {
    console.error("[AUDIT LOGS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
