import {
  listTransactionLogs,
  deleteTransactionLog,
} from "../../controllers/transactionLogs/transactionLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerTransactionLogsRoutes = (app) => {
  app.get("/api/transaction-logs", verifyToken, listTransactionLogs);
  app.delete("/api/transaction-logs/:id", verifyToken, deleteTransactionLog);
};
