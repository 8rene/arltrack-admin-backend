import {
  getAllUserLogs,
  getAllUserLogsArchive,
  archiveUserLog,
} from "../../services/userLogs/userLogs.service.js";

export const listUserLogs = async (req, res) => {
  try {
    const data = await getAllUserLogs();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER LOGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listUserLogsArchive = async (req, res) => {
  try {
    const data = await getAllUserLogsArchive();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER LOGS ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteUserLog = async (req, res) => {
  try {
    const { id } = req.params;
    await archiveUserLog(id);
    return res
      .status(200)
      .json({ success: true, message: "User log archived successfully." });
  } catch (error) {
    console.error("[USER LOGS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
