import {
  listPaymentsArchives,
  restorePaymentsArchiveHandler,
  deletePaymentsArchiveHandler,
} from "../../controllers/archives/paymentsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only
const allowed = [roles.OWNER, roles.ADMIN];

export const registerPaymentsArchiveRoutes = (app) => {
  app.get("/api/archives/payments",                                      verifyToken, requireRole(allowed), listPaymentsArchives);
  app.post("/api/archives/payments/:paymentsArchivesId/restore",         verifyToken, requireRole(allowed), restorePaymentsArchiveHandler);
  app.delete("/api/archives/payments/:paymentsArchivesId",               verifyToken, requireRole(allowed), deletePaymentsArchiveHandler);
};