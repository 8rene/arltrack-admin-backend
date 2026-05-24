import {
  getAllUserLogArchives,
  restoreUserLogArchive,
  deleteUserLogArchive,
} from "../../services/archives/userLogArchives.service.js";

export const listUserLogArchives = async (req, res) => {
  try {
    const data = await getAllUserLogArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER LOG ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreUserLogArchiveHandler = async (req, res) => {
  try {
    const { userLogArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    await restoreUserLogArchive(userLogArchivesId, restoredBy);
    return res.status(200).json({ success: true, message: "User log restored successfully." });
  } catch (error) {
    console.error("[USER LOG ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteUserLogArchiveHandler = async (req, res) => {
  try {
    const { userLogArchivesId } = req.params;
    await deleteUserLogArchive(userLogArchivesId);
    return res.status(200).json({ success: true, message: "Archived user log permanently deleted." });
  } catch (error) {
    console.error("[USER LOG ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
