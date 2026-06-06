import { listPayments, getPayment, patchPaymentStatus } from "../../controllers/payments/payments.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentsRoutes = (app) => {
  app.get("/api/payments",             verifyToken, requireRole(allowed), listPayments);
  app.get("/api/payments/:id",         verifyToken, requireRole(allowed), getPayment);
  app.patch("/api/payments/:id/status",verifyToken, requireRole(allowed), patchPaymentStatus);
};