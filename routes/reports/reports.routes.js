import { getReport } from "../../controllers/reports/reports.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerReportsRoutes = (app) => {
  app.get("/api/reports", verifyToken, requireRole(allowed), getReport);
};