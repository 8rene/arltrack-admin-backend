import { listPayments, getPayment, patchPaymentStatus, collectBalance, notifyBalance, discountPayment, refundIssued, retryDiscountRefundPayment } from "../../controllers/payments/payments.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentsRoutes = (app) => {
  app.get("/api/payments",             verifyToken, requireRole(allowed), listPayments);
  app.get("/api/payments/:id",         verifyToken, requireRole(allowed), getPayment);
  app.patch("/api/payments/:id/status",verifyToken, requireRole(allowed), patchPaymentStatus);

  // No delete here: a payment is archived together with its booking (DELETE /api/bookings/:id).
  // Keyed by bookingID (not the payment doc id) since that's what staff
  // screens have on hand for a booking.
  //
  // Every payment goes through PayMongo, so there is no route that marks a first payment as
  // received by hand. What's left:

  // The remaining balance is paid online; this nudges the customer to do it (6-hour cooldown).
  app.post("/api/payments/booking/:bookingID/notify-balance", verifyToken, requireRole(allowed), notifyBalance);

  // The EXCEPTION: the customer chose to pay the remaining balance in store. Supervisor / Admin /
  // Owner only (`allowed`), with the payment mode and a reference number on record.
  app.patch("/api/payments/booking/:bookingID/collect-balance", verifyToken, requireRole(allowed), collectBalance);

  // Gives a discount. No edits and no correction route: a discount that was too small is fixed by giving another.
  // On a partial payment it comes off the remaining balance; on a fully paid one it is held and returns with the security deposit.
  app.patch("/api/payments/booking/:bookingID/discount", verifyToken, requireRole(allowed), discountPayment);

  // LEGACY discounts only (refunded on the spot before the ledger): the PayMongo refund failed, send it again. A ledger discount
  // returns with the deposit, so its retry is the deposit return's.
  app.patch("/api/payments/booking/:bookingID/discount-refund/retry", verifyToken, requireRole(allowed), retryDiscountRefundPayment);

  // Only for a refund that couldn't go through PayMongo (money received in store): records the
  // in-store hand-back with its mode and reference number.
  app.patch("/api/payments/booking/:bookingID/refund-issued", verifyToken, requireRole(allowed), refundIssued);
};