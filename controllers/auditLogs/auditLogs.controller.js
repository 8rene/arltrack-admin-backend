import { getAllAuditLogs, archiveAuditLog, createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listAuditLogs = async (req, res) => {
  try {
    const data = await getAllAuditLogs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[AUDIT LOGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Any logged-in staff member allowed to call this route (see routes file)
// can write an entry — req.user.uid (set by verifyToken) is trusted as the
// performer rather than anything the client sends, so it can't be spoofed.
export const addAuditLog = async (req, res) => {
  try {
    const { action, description } = req.body;
    const data = await createAuditLog({ action, description, userID: req.user?.uid || null });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[AUDIT LOGS] create error:", error);
    return res.status(400).json({ success: false, message: error.message });
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