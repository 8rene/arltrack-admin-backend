import { listAuditLogs, deleteAuditLog } from "../../controllers/auditLogs/auditLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerAuditLogsRoutes = (app) => {
  app.get("/api/audit-logs", verifyToken, listAuditLogs);
  app.delete("/api/audit-logs/:id", verifyToken, deleteAuditLog);
};
