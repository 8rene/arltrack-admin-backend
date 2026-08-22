import {
  listRefundArchives,
  restoreRefundArchiveHandler,
  deleteRefundArchiveHandler,
} from "../../controllers/archives/refundArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner, Admin
const allowed = [roles.OWNER, roles.ADMIN];

export const registerRefundArchiveRoutes = (app) => {
  app.get("/api/archives/refund-requests",                             verifyToken, requireRole(allowed), listRefundArchives);
  app.post("/api/archives/refund-requests/:refundArchivesId/restore",  verifyToken, requireRole(allowed), restoreRefundArchiveHandler);
  app.delete("/api/archives/refund-requests/:refundArchivesId",        verifyToken, requireRole(allowed), deleteRefundArchiveHandler);
};