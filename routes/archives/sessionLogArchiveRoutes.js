import {
  listSessionLogArchives,
  restoreSessionLogArchiveHandler,
  deleteSessionLogArchiveHandler,
} from "../../controllers/archives/sessionLogArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerSessionLogArchiveRoutes = (app) => {
  app.get("/api/archives/session-log",                             verifyToken, requireRole(allowed), listSessionLogArchives);
  app.post("/api/archives/session-log/:sessionLogArchivesId/restore", verifyToken, requireRole(allowed), restoreSessionLogArchiveHandler);
  app.delete("/api/archives/session-log/:sessionLogArchivesId",     verifyToken, requireRole(deleteAllowed), deleteSessionLogArchiveHandler);
};