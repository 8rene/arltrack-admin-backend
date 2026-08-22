import { getAllReviewsGroupedByCar, getReviewsForCar, archiveAndDeleteReview } from "../../services/reviews/reviews.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

// GET /api/reviews — live reviews grouped by car, for the admin Reviews page
export const listReviews = async (req, res) => {
  try {
    const data = await getAllReviewsGroupedByCar();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REVIEWS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/reviews/car/:carID — reviews for one car (loaded on demand once
// a car is selected, mirroring GET /api/car-parts/car/:carID)
export const getCarReviews = async (req, res) => {
  try {
    const { carID } = req.params;
    if (!carID) return res.status(400).json({ success: false, message: "carID is required." });
    const data = await getReviewsForCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REVIEWS] getCarReviews error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/reviews/:reviewID — archives then removes the live review
export const deleteReviewHandler = async (req, res) => {
  try {
    const { reviewID } = req.params;
    const deletedBy = req.user?.username || req.user?.uid || "admin";
    const archiveID = await archiveAndDeleteReview(reviewID, deletedBy);

    createAuditLog({
      action: "delete",
      description: `Deleted review ${reviewID} (archived as ${archiveID}).`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[REVIEWS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, message: "Review deleted and archived.", archiveID });
  } catch (error) {
    console.error("[REVIEWS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};