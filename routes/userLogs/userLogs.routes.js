import {
  listUserLogs,
  listUserLogsArchive,
  deleteUserLog,
} from "../../controllers/userLogs/userLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin
const allowed = [roles.SUPERVISOR, roles.ADMIN];

export const registerUserLogsRoutes = (app) => {
  app.get("/api/user-logs",          verifyToken, requireRole(allowed), listUserLogs);
  app.get("/api/user-logs-archive",  verifyToken, requireRole(allowed), listUserLogsArchive);
  app.delete("/api/user-logs/:id",   verifyToken, requireRole(allowed), deleteUserLog);
};