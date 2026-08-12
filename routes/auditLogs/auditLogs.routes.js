import { listAuditLogs, deleteAuditLog, addAuditLog } from "../../controllers/auditLogs/auditLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Admin
const allowed = [roles.ADMIN];

// Writing a log entry is allowed for anyone whose actions actually get
// logged (e.g. Fleet.jsx's status changes are usable by Owner/Admin/
// Supervisor) — narrower than "allowed" above, which only gates viewing
// the log page itself.
const canWrite = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerAuditLogsRoutes = (app) => {
  app.get("/api/audit-logs",      verifyToken, requireRole(allowed), listAuditLogs);
  app.post("/api/audit-logs",     verifyToken, requireRole(canWrite), addAuditLog);
  app.delete("/api/audit-logs/:id",verifyToken, requireRole(allowed), deleteAuditLog);
};