import { listReviews, getCarReviews, getReviewCounts, deleteReviewHandler } from "../../controllers/reviews/reviews.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Matches the access already declared for Reviews Archive (routes/archives/reviewsArchiveRoutes) — Owner, Admin.
const allowed = [roles.OWNER, roles.ADMIN];

export const registerReviewsRoutes = (app) => {
  app.get("/api/reviews", verifyToken, requireRole(allowed), listReviews);
  app.get("/api/reviews/car/:carID", verifyToken, requireRole(allowed), getCarReviews);
  app.post("/api/reviews/counts", verifyToken, requireRole(allowed), getReviewCounts);
  app.delete("/api/reviews/:reviewID", verifyToken, requireRole(allowed), deleteReviewHandler);
};