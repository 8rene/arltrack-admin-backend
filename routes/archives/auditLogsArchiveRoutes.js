import {
  listAuditLogsArchives,
  restoreAuditLogsArchiveHandler,
  deleteAuditLogsArchiveHandler,
} from "../../controllers/archives/auditLogsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerAuditLogsArchiveRoutes = (app) => {
  app.get("/api/archives/audit-logs",                                          verifyToken, requireRole(allowed), listAuditLogsArchives);
  app.post("/api/archives/audit-logs/:auditLogsArchivesId/restore",            verifyToken, requireRole(allowed), restoreAuditLogsArchiveHandler);
  app.delete("/api/archives/audit-logs/:auditLogsArchivesId",                  verifyToken, requireRole(deleteAllowed), deleteAuditLogsArchiveHandler);
};