import {
  listReviewsArchives,
  restoreReviewsArchiveHandler,
  deleteReviewsArchiveHandler,
} from "../../controllers/archives/reviewsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerReviewsArchiveRoutes = (app) => {
  app.get("/api/archives/reviews",                                    verifyToken, requireRole(allowed), listReviewsArchives);
  app.post("/api/archives/reviews/:reviewsArchivesID/restore",        verifyToken, requireRole(allowed), restoreReviewsArchiveHandler);
  app.delete("/api/archives/reviews/:reviewsArchivesID",              verifyToken, requireRole(deleteAllowed), deleteReviewsArchiveHandler);
};