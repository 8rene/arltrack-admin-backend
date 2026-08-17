import {
  listUserArchives,
  restoreUserArchiveHandler,
  deleteUserArchiveHandler,
} from "../../controllers/archives/userArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only
const allowed = [roles.OWNER, roles.ADMIN];

export const registerUserArchiveRoutes = (app) => {
  app.get("/api/archives/users",                          verifyToken, requireRole(allowed), listUserArchives);
  app.post("/api/archives/users/:userArchivesId/restore",  verifyToken, requireRole(allowed), restoreUserArchiveHandler);
  app.delete("/api/archives/users/:userArchivesId",        verifyToken, requireRole(allowed), deleteUserArchiveHandler);
};