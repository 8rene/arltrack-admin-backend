import {
  listUserArchives,
  restoreUserArchiveHandler,
  deleteUserArchiveHandler,
  mergeCandidateHandler,
  mergeUserArchiveHandler,
} from "../../controllers/archives/userArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerUserArchiveRoutes = (app) => {
  app.get("/api/archives/users",                          verifyToken, requireRole(allowed), listUserArchives);
  app.post("/api/archives/users/:userArchivesId/restore",  verifyToken, requireRole(allowed), restoreUserArchiveHandler);
  app.delete("/api/archives/users/:userArchivesId",        verifyToken, requireRole(deleteAllowed), deleteUserArchiveHandler);
  app.get("/api/archives/users/:userArchivesId/merge-candidate", verifyToken, requireRole(allowed), mergeCandidateHandler);
  app.post("/api/archives/users/:userArchivesId/merge",         verifyToken, requireRole(allowed), mergeUserArchiveHandler);
};