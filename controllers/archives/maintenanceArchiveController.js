import {
  getAllMaintenanceArchives,
  restoreMaintenanceArchive,
  deleteMaintenanceArchive,
} from "../../services/archives/maintenanceArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listMaintenanceArchives = async (req, res) => {
  try {
    const data = await getAllMaintenanceArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreMaintenanceArchiveHandler = async (req, res) => {
  try {
    const { maintenanceArchivesId } = req.params;
    const result = await restoreMaintenanceArchive(maintenanceArchivesId);
    createAuditLog({
      action: "update",
      description: `Restored archived maintenance record ${maintenanceArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[MAINTENANCE ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: `Maintenance record restored successfully.${result.bookingStillArchived ? " Its booking is still archived; restore it from the Booking Archive." : ""}`,
      data: result,
    });
  } catch (error) {
    console.error("[MAINTENANCE ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteMaintenanceArchiveHandler = async (req, res) => {
  try {
    const { maintenanceArchivesId } = req.params;
    await deleteMaintenanceArchive(maintenanceArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived maintenance record ${maintenanceArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[MAINTENANCE ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived maintenance record permanently deleted." });
  } catch (error) {
    console.error("[MAINTENANCE ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
