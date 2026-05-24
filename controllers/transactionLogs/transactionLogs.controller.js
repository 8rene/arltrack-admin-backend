import {
  getAllTransactionLogs,
  archiveTransactionLog,
} from "../../services/transactionLogs/transactionLogs.service.js";

export const listTransactionLogs = async (req, res) => {
  try {
    const data = await getAllTransactionLogs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[TRANSACTION LOGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteTransactionLog = async (req, res) => {
  try {
    const { id } = req.params;
    await archiveTransactionLog(id);
    return res.status(200).json({ success: true, message: "Transaction log archived successfully." });
  } catch (error) {
    console.error("[TRANSACTION LOGS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
