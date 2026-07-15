import { analyticsData } from "../../controllers/analytics/analytics.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerAnalyticsRoutes = (app) => {
  app.get("/api/analytics", verifyToken, requireRole(allowed), analyticsData);
};