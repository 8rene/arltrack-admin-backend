import {
  listRefundArchives,
  restoreRefundArchiveHandler,
  deleteRefundArchiveHandler,
} from "../../controllers/archives/refundArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER, roles.ADMIN]; // Admin may permanently delete too; a delete always takes the whole booking while its booking archive exists

export const registerRefundArchiveRoutes = (app) => {
  app.get("/api/archives/refund-requests",                             verifyToken, requireRole(allowed), listRefundArchives);
  app.post("/api/archives/refund-requests/:refundArchivesId/restore",  verifyToken, requireRole(allowed), restoreRefundArchiveHandler);
  app.delete("/api/archives/refund-requests/:refundArchivesId",        verifyToken, requireRole(deleteAllowed), deleteRefundArchiveHandler);
};