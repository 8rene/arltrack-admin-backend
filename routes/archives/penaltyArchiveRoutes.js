import {
  listPenaltyArchives,
  restorePenaltyArchiveHandler,
  deletePenaltyArchiveHandler,
} from "../../controllers/archives/penaltyArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only.
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerPenaltyArchiveRoutes = (app) => {
  app.get("/api/archives/penalties",                             verifyToken, requireRole(allowed), listPenaltyArchives);
  app.post("/api/archives/penalties/:penaltyArchivesId/restore", verifyToken, requireRole(allowed), restorePenaltyArchiveHandler);
  app.delete("/api/archives/penalties/:penaltyArchivesId",       verifyToken, requireRole(deleteAllowed), deletePenaltyArchiveHandler);
};