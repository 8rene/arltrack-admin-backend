import {
  listInspectionArchives,
} from "../../controllers/archives/vehicleInspectionArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Read-only. Restore and permanent delete are done from the Booking Archive only (they always take the whole booking).
const allowed = [roles.OWNER, roles.ADMIN];

export const registerInspectionArchiveRoutes = (app) => {
  app.get("/api/archives/vehicle-inspection",                                       verifyToken, requireRole(allowed),       listInspectionArchives);
};