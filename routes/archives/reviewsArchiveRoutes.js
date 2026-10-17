import {
  listReviewsArchives,
} from "../../controllers/archives/reviewsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Read-only. Restore and permanent delete are done from the Booking Archive only (they always take the whole booking).
const allowed = [roles.OWNER, roles.ADMIN];

export const registerReviewsArchiveRoutes = (app) => {
  app.get("/api/archives/reviews",                                    verifyToken, requireRole(allowed), listReviewsArchives);
};