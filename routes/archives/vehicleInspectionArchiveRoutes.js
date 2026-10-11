import {
  listInspectionArchives,
  restoreInspectionArchiveHandler,
  deleteInspectionArchiveHandler,
} from "../../controllers/archives/vehicleInspectionArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View, restore and permanent delete: Owner and Admin. Supervisor has no archive access.
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER, roles.ADMIN]; // Admin may permanently delete too; a delete always takes the whole booking while its booking archive exists

export const registerInspectionArchiveRoutes = (app) => {
  app.get("/api/archives/vehicle-inspection",                                       verifyToken, requireRole(allowed),       listInspectionArchives);
  app.post("/api/archives/vehicle-inspection/:vehicleInspectionArchivesId/restore",       verifyToken, requireRole(allowed),       restoreInspectionArchiveHandler);
  app.delete("/api/archives/vehicle-inspection/:vehicleInspectionArchivesId",             verifyToken, requireRole(deleteAllowed), deleteInspectionArchiveHandler);
};