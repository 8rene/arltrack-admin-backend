import {
  listPaymentsArchives,
  restorePaymentsArchiveHandler,
  deletePaymentsArchiveHandler,
} from "../../controllers/archives/paymentsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerPaymentsArchiveRoutes = (app) => {
  // GET    /api/archives/payments
  app.get("/api/archives/payments", verifyToken, listPaymentsArchives);

  // POST   /api/archives/payments/:paymentsArchivesId/restore
  app.post("/api/archives/payments/:paymentsArchivesId/restore", verifyToken, restorePaymentsArchiveHandler);

  // DELETE /api/archives/payments/:paymentsArchivesId
  app.delete("/api/archives/payments/:paymentsArchivesId", verifyToken, deletePaymentsArchiveHandler);
};
