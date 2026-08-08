import {
  listTransactionLogs,
  deleteTransactionLog,
} from "../../controllers/transactionLogs/transactionLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Admin
const allowed = [roles.ADMIN];

export const registerTransactionLogsRoutes = (app) => {
  app.get("/api/transaction-logs",       verifyToken, requireRole(allowed), listTransactionLogs);
  app.delete("/api/transaction-logs/:id",verifyToken, requireRole(allowed), deleteTransactionLog);
};