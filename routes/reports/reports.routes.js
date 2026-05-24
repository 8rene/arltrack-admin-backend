import { getReport } from "../../controllers/reports/reports.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerReportsRoutes = (app) => {
  app.get("/api/reports", verifyToken, getReport);
};
