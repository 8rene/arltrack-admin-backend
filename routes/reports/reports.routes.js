import { getReport, getMaintenancePenaltiesReport, getMoneyReport } from "../../controllers/reports/reports.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner only.
const allowed = [roles.OWNER];

export const registerReportsRoutes = (app) => {
  app.get("/api/reports", verifyToken, requireRole(allowed), getReport);
  app.get("/api/reports/maintenance-penalties", verifyToken, requireRole(allowed), getMaintenancePenaltiesReport);
  app.get("/api/reports/money", verifyToken, requireRole(allowed), getMoneyReport);
};