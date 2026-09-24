import { listRefundRequests, approveRefund, rejectRefund, manualRefundIssued, staffRefund } from "../../controllers/refundRequest/refundRequest.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner — same access level as Payments
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerRefundRequestRoutes = (app) => {
  app.get("/api/refund-requests",              verifyToken, requireRole(allowed), listRefundRequests);
  app.patch("/api/refund-requests/:id/approve", verifyToken, requireRole(allowed), approveRefund);
  app.patch("/api/refund-requests/:id/reject",  verifyToken, requireRole(allowed), rejectRefund);
  // Staff confirm the in-person part of a refund (the balance PayMongo can't return) was handed back.
  app.patch("/api/refund-requests/:id/manual-issued", verifyToken, requireRole(allowed), manualRefundIssued);
  // Staff force-cancel + refund one upcoming booking directly (no prior customer request) —
  // used by Fleet.jsx's status-change flow when switching a car to Maintenance/Inactive.
  app.post("/api/refund-requests/staff-refund/:bookingID", verifyToken, requireRole(allowed), staffRefund);
};