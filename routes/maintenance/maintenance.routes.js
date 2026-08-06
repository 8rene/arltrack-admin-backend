import {
  getConfig,
  listMaintenance,
  getOneMaintenance,
  listMaintenanceByCar,
  addMaintenance,
  editMaintenance,
  setMaintenanceStatus,
  removeMaintenance,
} from "../../controllers/maintenance/maintenance.controller.js";
import { verifyToken }        from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Owner + Admin + Supervisor — matches the decided access for the
// Maintenance page (frontend/src/config/pagePermissions.js: "/maintenance").
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerMaintenanceRoutes = (app) => {
  app.get   ("/api/maintenance/config",       verifyToken, requireRole(allowed), getConfig);
  app.get   ("/api/maintenance/car/:carID",   verifyToken, requireRole(allowed), listMaintenanceByCar);
  app.get   ("/api/maintenance/:id",          verifyToken, requireRole(allowed), getOneMaintenance);
  app.get   ("/api/maintenance",              verifyToken, requireRole(allowed), listMaintenance);
  app.post  ("/api/maintenance",              verifyToken, requireRole(allowed), addMaintenance);
  app.put   ("/api/maintenance/:id",          verifyToken, requireRole(allowed), editMaintenance);
  app.patch ("/api/maintenance/:id/status",   verifyToken, requireRole(allowed), setMaintenanceStatus);
  app.delete("/api/maintenance/:id",          verifyToken, requireRole(allowed), removeMaintenance);
};