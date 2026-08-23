import {
  listPaymentsArchives,
  restorePaymentsArchiveHandler,
  deletePaymentsArchiveHandler,
} from "../../controllers/archives/paymentsArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerPaymentsArchiveRoutes = (app) => {
  app.get("/api/archives/payments",                                      verifyToken, requireRole(allowed), listPaymentsArchives);
  app.post("/api/archives/payments/:paymentsArchivesId/restore",         verifyToken, requireRole(allowed), restorePaymentsArchiveHandler);
  app.delete("/api/archives/payments/:paymentsArchivesId",               verifyToken, requireRole(deleteAllowed), deletePaymentsArchiveHandler);
};