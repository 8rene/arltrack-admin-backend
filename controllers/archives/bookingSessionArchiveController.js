import {
  getAllBookingSessionArchives,
} from "../../services/archives/bookingSessionArchives.service.js";
import { restoreArchiveItem, deleteArchiveItem, restoreMessage, deleteMessage } from "../../services/archives/archiveBundle.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listBookingSessionArchives = async (req, res) => {
  try {
    const data = await getAllBookingSessionArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKING SESSION ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreBookingSessionArchiveHandler = async (req, res) => {
  try {
    const { bookingSessionArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreArchiveItem("sessions", bookingSessionArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived booking session ${bookingSessionArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[BOOKING SESSION ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: restoreMessage("sessions", result),
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING SESSION ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteBookingSessionArchiveHandler = async (req, res) => {
  try {
    const { bookingSessionArchivesId } = req.params;
    const result = await deleteArchiveItem("sessions", bookingSessionArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived booking session ${bookingSessionArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[BOOKING SESSION ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: deleteMessage("sessions", result),
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING SESSION ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};