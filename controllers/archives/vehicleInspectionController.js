import {
  getAllInspectionArchives,
} from "../../services/archives/vehicleInspectionArchives.service.js";
import { restoreArchiveItem, deleteArchiveItem, restoreMessage, deleteMessage } from "../../services/archives/archiveBundle.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listInspectionArchives = async (req, res) => {
  try {
    const data = await getAllInspectionArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[INSPECTION ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreInspectionArchiveHandler = async (req, res) => {
  try {
    const { vehicleInspectionArchivesId } = req.params;
    const result = await restoreArchiveItem("inspection", vehicleInspectionArchivesId, req.user?.username || req.user?.uid || "admin");
    createAuditLog({
      action: "update",
      description: `Restored archived vehicle inspection ${vehicleInspectionArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[INSPECTION ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: restoreMessage("inspection", result),
      data: result,
    });
  } catch (error) {
    console.error("[INSPECTION ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteInspectionArchiveHandler = async (req, res) => {
  try {
    const { vehicleInspectionArchivesId } = req.params;
    const result = await deleteArchiveItem("inspection", vehicleInspectionArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived vehicle inspection ${vehicleInspectionArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[INSPECTION ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: deleteMessage("inspection", result), data: result });
  } catch (error) {
    console.error("[INSPECTION ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};