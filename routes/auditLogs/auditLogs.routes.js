import { listAuditLogs, listAuditLogsByUser, deleteAuditLog, addAuditLog } from "../../controllers/auditLogs/auditLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Admin
const allowed = [roles.ADMIN];

// One person's entries for the Activity tab on the Supervisors list, which Owner and Admin can both open
// (see ROLE_TABS in Users.jsx) — wider than "allowed" above, which gates the full log page (Admin only).
const byUserAllowed = [roles.OWNER, roles.ADMIN];

// Writing a log entry is allowed for anyone whose actions actually get
// logged (e.g. Fleet.jsx's status changes are usable by Owner/Admin/
// Supervisor) — narrower than "allowed" above, which only gates viewing
// the log page itself.
const canWrite = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerAuditLogsRoutes = (app) => {
  app.get("/api/audit-logs",      verifyToken, requireRole(allowed), listAuditLogs);
  app.get("/api/audit-logs/by-user/:uid", verifyToken, requireRole(byUserAllowed), listAuditLogsByUser);
  app.post("/api/audit-logs",     verifyToken, requireRole(canWrite), addAuditLog);
  app.delete("/api/audit-logs/:id",verifyToken, requireRole(allowed), deleteAuditLog);
};