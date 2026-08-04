import { listRefundRequests, approveRefund, rejectRefund } from "../../controllers/refundRequest/refundRequest.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner — same access level as Payments
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerRefundRequestRoutes = (app) => {
  app.get("/api/refund-requests",              verifyToken, requireRole(allowed), listRefundRequests);
  app.patch("/api/refund-requests/:id/approve", verifyToken, requireRole(allowed), approveRefund);
  app.patch("/api/refund-requests/:id/reject",  verifyToken, requireRole(allowed), rejectRefund);
};
