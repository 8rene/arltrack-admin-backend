import {
  listUserLogArchives,
  restoreUserLogArchiveHandler,
  deleteUserLogArchiveHandler,
} from "../../controllers/archives/userLogArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only
const allowed = [roles.OWNER];

export const registerUserLogArchiveRoutes = (app) => {
  app.get("/api/archives/user-log",                                      verifyToken, requireRole(allowed), listUserLogArchives);
  app.post("/api/archives/user-log/:userLogArchivesId/restore",          verifyToken, requireRole(allowed), restoreUserLogArchiveHandler);
  app.delete("/api/archives/user-log/:userLogArchivesId",                verifyToken, requireRole(allowed), deleteUserLogArchiveHandler);
};