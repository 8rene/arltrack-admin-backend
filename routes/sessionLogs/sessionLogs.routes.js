import {
  listSessionLogs,
  listSessionLogsArchive,
  deleteSessionLog,
} from "../../controllers/sessionLogs/sessionLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Admin
// Renamed from /api/user-logs — see sessionLogs.model.js for why.
const allowed = [roles.ADMIN];

export const registerSessionLogsRoutes = (app) => {
  app.get("/api/session-logs",          verifyToken, requireRole(allowed), listSessionLogs);
  app.get("/api/session-logs-archive",  verifyToken, requireRole(allowed), listSessionLogsArchive);
  app.delete("/api/session-logs/:id",   verifyToken, requireRole(allowed), deleteSessionLog);
};