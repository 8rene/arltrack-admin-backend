import {
  getAllPaymentsArchives,
  restorePaymentsArchive,
  deletePaymentsArchive,
} from "../../services/archives/paymentsArchives.service.js";

export const listPaymentsArchives = async (req, res) => {
  try {
    const data = await getAllPaymentsArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restorePaymentsArchiveHandler = async (req, res) => {
  try {
    const { paymentsArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    await restorePaymentsArchive(paymentsArchivesId, restoredBy);
    return res.status(200).json({ success: true, message: "Payment restored successfully." });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deletePaymentsArchiveHandler = async (req, res) => {
  try {
    const { paymentsArchivesId } = req.params;
    await deletePaymentsArchive(paymentsArchivesId);
    return res.status(200).json({ success: true, message: "Archived payment permanently deleted." });
  } catch (error) {
    console.error("[PAYMENTS ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
