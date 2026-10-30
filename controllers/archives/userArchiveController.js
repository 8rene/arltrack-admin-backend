import {
  getAllUserArchives,
  getUserArchiveProfile,
  restoreUserArchive,
  deleteUserArchive,
} from "../../services/archives/userArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listUserArchives = async (req, res) => {
  try {
    const data = await getAllUserArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserArchiveProfileHandler = async (req, res) => {
  try {
    const data = await getUserArchiveProfile(req.params.userArchivesId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER ARCHIVE] profile error:", error);
    const notFound = /not found/i.test(error.message);
    return res.status(notFound ? 404 : 500).json({ success: false, message: error.message });
  }
};

export const restoreUserArchiveHandler = async (req, res) => {
  try {
    const { userArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreUserArchive(userArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived user ${userArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER ARCHIVE] Failed to write audit log:", err));
    const { authRecreated, emailSent } = result;
    const message = authRecreated
      ? (emailSent
          ? "User restored. Their login was recreated and an email was sent asking them to reset their password."
          : "User restored and login recreated, but the email could not be sent. Ask them to use Forgot password.")
      : (emailSent
          ? "User restored. Their login is active again with their existing password, and they were emailed."
          : "User restored. Their login is active again with their existing password, but the email could not be sent.");
    return res.status(200).json({ success: true, message, data: result });
  } catch (error) {
    console.error("[USER ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteUserArchiveHandler = async (req, res) => {
  try {
    const { userArchivesId } = req.params;
    const result = await deleteUserArchive(userArchivesId);
    const fileNote = result.deletedFiles > 0 ? ` ${result.deletedFiles} stored file(s) removed from Storage.` : "";
    const reqCount = (result.deletedEditRequests || 0) + (result.deletedIdRequests || 0);
    const reqNote = reqCount > 0 ? ` ${reqCount} profile request(s) removed.` : "";
    const failNote = result.failedFiles > 0 ? ` ${result.failedFiles} file(s) could not be removed.` : "";
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived user ${userArchivesId}.${reqNote}${fileNote}${failNote}`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: `Archived user permanently deleted.${reqNote}${fileNote}${failNote}`, data: result });
  } catch (error) {
    console.error("[USER ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};