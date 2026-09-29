import {
  getAllUserArchives,
  restoreUserArchive,
  deleteUserArchive,
  findMergeCandidate,
  mergeUserArchive,
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
    return res.status(200).json({
      success: true,
      message: "User restored successfully. Note: they will need to sign up again (or have their login recreated) before they can log in.",
      data: result,
    });
  } catch (error) {
    console.error("[USER ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteUserArchiveHandler = async (req, res) => {
  try {
    const { userArchivesId } = req.params;
    await deleteUserArchive(userArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived user ${userArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived user permanently deleted." });
  } catch (error) {
    console.error("[USER ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const mergeCandidateHandler = async (req, res) => {
  try {
    const data = await findMergeCandidate(req.params.userArchivesId);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER ARCHIVE] merge-candidate error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const mergeUserArchiveHandler = async (req, res) => {
  try {
    const { userArchivesId } = req.params;
    const { targetUserID } = req.body || {};
    const mergedBy = req.user?.uid || "admin";
    const result = await mergeUserArchive(userArchivesId, targetUserID, mergedBy);
    createAuditLog({
      action: "update",
      description: `Merged archived user ${result.oldUserID} into account ${result.newUserID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived history merged into the current account.", data: result });
  } catch (error) {
    console.error("[USER ARCHIVE] merge error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};