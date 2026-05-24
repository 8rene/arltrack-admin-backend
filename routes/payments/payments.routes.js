import { listPayments, getPayment, patchPaymentStatus } from "../../controllers/payments/payments.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerPaymentsRoutes = (app) => {
  app.get("/api/payments", verifyToken, listPayments);
  app.get("/api/payments/:id", verifyToken, getPayment);
  app.patch("/api/payments/:id/status", verifyToken, patchPaymentStatus);
};
