import {
  listMaintenanceArchives,
  restoreMaintenanceArchiveHandler,
  deleteMaintenanceArchiveHandler,
} from "../../controllers/archives/maintenanceArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only (irreversible), same as the other archives.
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerMaintenanceArchiveRoutes = (app) => {
  app.get("/api/archives/maintenance",                                       verifyToken, requireRole(allowed),       listMaintenanceArchives);
  app.post("/api/archives/maintenance/:maintenanceArchivesId/restore",       verifyToken, requireRole(allowed),       restoreMaintenanceArchiveHandler);
  app.delete("/api/archives/maintenance/:maintenanceArchivesId",             verifyToken, requireRole(deleteAllowed), deleteMaintenanceArchiveHandler);
};
