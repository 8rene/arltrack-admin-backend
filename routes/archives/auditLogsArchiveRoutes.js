import {
  listAuditLogsArchives,
  restoreAuditLogsArchiveHandler,
  deleteAuditLogsArchiveHandler,
} from "../../controllers/archives/auditLogsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerAuditLogsArchiveRoutes = (app) => {
  // GET    /api/archives/audit-logs
  app.get("/api/archives/audit-logs", verifyToken, listAuditLogsArchives);

  // POST   /api/archives/audit-logs/:auditLogsArchivesId/restore
  app.post("/api/archives/audit-logs/:auditLogsArchivesId/restore", verifyToken, restoreAuditLogsArchiveHandler);

  // DELETE /api/archives/audit-logs/:auditLogsArchivesId
  app.delete("/api/archives/audit-logs/:auditLogsArchivesId", verifyToken, deleteAuditLogsArchiveHandler);
};
