import { listPayments, getPayment, patchPaymentStatus, collectBalance, confirmPayment } from "../../controllers/payments/payments.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentsRoutes = (app) => {
  app.get("/api/payments",             verifyToken, requireRole(allowed), listPayments);
  app.get("/api/payments/:id",         verifyToken, requireRole(allowed), getPayment);
  app.patch("/api/payments/:id/status",verifyToken, requireRole(allowed), patchPaymentStatus);
  // Keyed by bookingID (not the payment doc id) since that's what staff
  // screens like Car Tracking have on hand for a booking.
  app.patch("/api/payments/booking/:bookingID/collect-balance", verifyToken, requireRole(allowed), collectBalance);
  // Confirm a cash/in-person initial payment directly from Car Tracking —
  // no need to go to the Payments page just for this.
  app.patch("/api/payments/booking/:bookingID/confirm", verifyToken, requireRole(allowed), confirmPayment);
};