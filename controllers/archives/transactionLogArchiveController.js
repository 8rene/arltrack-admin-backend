import {
  getAllTransactionLogArchives,
  restoreTransactionLogArchive,
  deleteTransactionLogArchive,
} from "../../services/archives/transactionLogArchives.service.js";

export const listTransactionLogArchives = async (req, res) => {
  try {
    const data = await getAllTransactionLogArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[TRANSACTION LOG ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreTransactionLogArchiveHandler = async (req, res) => {
  try {
    const { transactionLogArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    await restoreTransactionLogArchive(transactionLogArchivesId, restoredBy);
    return res.status(200).json({ success: true, message: "Transaction log restored successfully." });
  } catch (error) {
    console.error("[TRANSACTION LOG ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteTransactionLogArchiveHandler = async (req, res) => {
  try {
    const { transactionLogArchivesId } = req.params;
    await deleteTransactionLogArchive(transactionLogArchivesId);
    return res.status(200).json({ success: true, message: "Archived transaction log permanently deleted." });
  } catch (error) {
    console.error("[TRANSACTION LOG ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
