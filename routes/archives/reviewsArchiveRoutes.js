/**
 * reviewsArchiveRoutes.js
 *
 * GET    /api/archives/reviews
 * POST   /api/archives/reviews/:reviewsArchivesID/restore
 * DELETE /api/archives/reviews/:reviewsArchivesID
 */

import {
  listReviewsArchives,
  restoreReviewsArchiveHandler,
  deleteReviewsArchiveHandler,
} from "../../controllers/archives/reviewsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerReviewsArchiveRoutes = (app) => {
  app.get("/api/archives/reviews", verifyToken, listReviewsArchives);
  app.post("/api/archives/reviews/:reviewsArchivesID/restore", verifyToken, restoreReviewsArchiveHandler);
  app.delete("/api/archives/reviews/:reviewsArchivesID", verifyToken, deleteReviewsArchiveHandler);
};
