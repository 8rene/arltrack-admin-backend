import { getPaymentEntries } from "../../controllers/paymentEntries/paymentEntries.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Read-only. Same audience as the Payments / Penalties / Refund pages.
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentEntriesRoutes = (app) => {
  app.get("/api/payment-entries", verifyToken, requireRole(allowed), getPaymentEntries);
};