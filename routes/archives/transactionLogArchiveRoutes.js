import {
  listTransactionLogArchives,
  restoreTransactionLogArchiveHandler,
  deleteTransactionLogArchiveHandler,
} from "../../controllers/archives/transactionLogArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerTransactionLogArchiveRoutes = (app) => {
  // GET    /api/archives/transaction-logs
  app.get("/api/archives/transaction-logs", verifyToken, listTransactionLogArchives);

  // POST   /api/archives/transaction-logs/:transactionLogArchivesId/restore
  app.post("/api/archives/transaction-logs/:transactionLogArchivesId/restore", verifyToken, restoreTransactionLogArchiveHandler);

  // DELETE /api/archives/transaction-logs/:transactionLogArchivesId
  app.delete("/api/archives/transaction-logs/:transactionLogArchivesId", verifyToken, deleteTransactionLogArchiveHandler);
};
