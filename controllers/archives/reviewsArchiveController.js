/**
 * reviewsArchiveController.js
 *
 * Handlers for GET / restore / permanent-delete of reviewsArchives.
 * Mirrors bookingArchiveController.js and paymentsArchiveController.js.
 */

import {
  getAllReviewsArchives,
  restoreReviewsArchive,
  deleteReviewsArchive,
} from "../../services/archives/reviewsArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

export const listReviewsArchives = async (req, res) => {
  try {
    const data = await getAllReviewsArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REVIEWS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreReviewsArchiveHandler = async (req, res) => {
  try {
    const { reviewsArchivesID } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    await restoreReviewsArchive(reviewsArchivesID, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived review ${reviewsArchivesID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[REVIEWS ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Review restored successfully." });
  } catch (error) {
    console.error("[REVIEWS ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteReviewsArchiveHandler = async (req, res) => {
  try {
    const { reviewsArchivesID } = req.params;
    await deleteReviewsArchive(reviewsArchivesID);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived review ${reviewsArchivesID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[REVIEWS ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: "Archived review permanently deleted." });
  } catch (error) {
    console.error("[REVIEWS ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};