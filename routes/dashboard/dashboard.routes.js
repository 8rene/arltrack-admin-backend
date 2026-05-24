import { dashboardMetrics } from "../../controllers/dashboard/dashboard.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerDashboardRoutes = (app) => {
  app.get("/api/dashboard/metrics", verifyToken, dashboardMetrics);
};
