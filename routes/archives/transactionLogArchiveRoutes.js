import {
  listTransactionLogArchives,
  restoreTransactionLogArchiveHandler,
  deleteTransactionLogArchiveHandler,
} from "../../controllers/archives/transactionLogArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only
const allowed = [roles.OWNER, roles.ADMIN];

export const registerTransactionLogArchiveRoutes = (app) => {
  app.get("/api/archives/transaction-logs",                                              verifyToken, requireRole(allowed), listTransactionLogArchives);
  app.post("/api/archives/transaction-logs/:transactionLogArchivesId/restore",           verifyToken, requireRole(allowed), restoreTransactionLogArchiveHandler);
  app.delete("/api/archives/transaction-logs/:transactionLogArchivesId",                 verifyToken, requireRole(allowed), deleteTransactionLogArchiveHandler);
};