import {
  getAllSessionLogs,
  getAllSessionLogsArchive,
  archiveSessionLog,
} from "../../services/sessionLogs/sessionLogs.service.js";

export const listSessionLogs = async (req, res) => {
  try {
    const data = await getAllSessionLogs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SESSION LOGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listSessionLogsArchive = async (req, res) => {
  try {
    const data = await getAllSessionLogsArchive();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SESSION LOGS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteSessionLog = async (req, res) => {
  try {
    const { id } = req.params;
    await archiveSessionLog(id);
    return res
      .status(200)
      .json({ success: true, message: "Session log archived successfully." });
  } catch (error) {
    console.error("[SESSION LOGS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};