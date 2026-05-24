import {
  getAllBookingArchives,
  restoreBookingArchive,
  deleteBookingArchive,
} from "../../services/archives/bookingArchives.service.js";

export const listBookingArchives = async (req, res) => {
  try {
    const data = await getAllBookingArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreBookingArchiveHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreBookingArchive(bookingArchivesId, restoredBy);
    return res.status(200).json({
      success: true,
      message: `Booking restored successfully.${result.restoredPayment ? " Payment also restored." : ""}${result.restoredReviews > 0 ? ` ${result.restoredReviews} review(s) also restored.` : ""}`,
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteBookingArchiveHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const result = await deleteBookingArchive(bookingArchivesId);
    return res.status(200).json({
      success: true,
      message: `Archived booking permanently deleted.${result.deletedPaymentArchive ? " Linked payment archive also deleted." : ""}${result.deletedReviewArchives > 0 ? ` ${result.deletedReviewArchives} review archive(s) also deleted.` : ""}`,
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
