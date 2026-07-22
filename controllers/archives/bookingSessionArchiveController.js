import {
  getAllBookingSessionArchives,
  restoreBookingSessionArchive,
  deleteBookingSessionArchive,
} from "../../services/archives/bookingSessionArchives.service.js";

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
    const result = await restoreBookingSessionArchive(bookingSessionArchivesId, restoredBy);
    return res.status(200).json({
      success: true,
      message: `Booking session restored successfully. ${result.restoredDaysCount} archive day-doc(s) also restored.`,
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
    const result = await deleteBookingSessionArchive(bookingSessionArchivesId);
    return res.status(200).json({
      success: true,
      message: "Archived booking session permanently deleted.",
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING SESSION ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};