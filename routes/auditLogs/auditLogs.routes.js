import { listAuditLogs, deleteAuditLog } from "../../controllers/auditLogs/auditLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin
const allowed = [roles.SUPERVISOR, roles.ADMIN];

export const registerAuditLogsRoutes = (app) => {
  app.get("/api/audit-logs",      verifyToken, requireRole(allowed), listAuditLogs);
  app.delete("/api/audit-logs/:id",verifyToken, requireRole(allowed), deleteAuditLog);
};