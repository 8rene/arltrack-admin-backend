import { analyticsData } from "../../controllers/analytics/analytics.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerAnalyticsRoutes = (app) => {
  // GET /api/analytics?type=daily
  // GET /api/analytics?type=monthly
  // GET /api/analytics?type=yearly
  app.get("/api/analytics", verifyToken, analyticsData);
};
