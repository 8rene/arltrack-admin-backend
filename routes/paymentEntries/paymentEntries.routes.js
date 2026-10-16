import { getPaymentEntries } from "../../controllers/paymentEntries/paymentEntries.controller.js";
import { getReceipt, emailReceipt } from "../../controllers/receipts/receipt.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Read-only. Same audience as the Payments / Penalties / Refund pages.
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentEntriesRoutes = (app) => {
  app.get("/api/payment-entries", verifyToken, requireRole(allowed), getPaymentEntries);
  // One printable receipt / slip for a single successful money movement. Same audience as the list above.
  app.get("/api/payment-entries/:entryID/receipt", verifyToken, requireRole(allowed), getReceipt);
  // Email that receipt to the customer's account address (no body: staff cannot choose the recipient).
  app.post("/api/payment-entries/:entryID/receipt/email", verifyToken, requireRole(allowed), emailReceipt);
};