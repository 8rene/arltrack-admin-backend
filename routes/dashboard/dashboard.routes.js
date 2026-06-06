import { dashboardMetrics } from "../../controllers/dashboard/dashboard.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerDashboardRoutes = (app) => {
  app.get("/api/dashboard/metrics", verifyToken, requireRole(allowed), dashboardMetrics);
};    