import { listPayments, getPayment, patchPaymentStatus, collectBalance, notifyBalance, discountPayment, refundIssued } from "../../controllers/payments/payments.controller.js";
import { deleteHandler, previewDeleteHandler } from "../../controllers/booking/bookingDelete.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerPaymentsRoutes = (app) => {
  app.get("/api/payments",             verifyToken, requireRole(allowed), listPayments);
  app.get("/api/payments/:id",         verifyToken, requireRole(allowed), getPayment);
  app.patch("/api/payments/:id/status",verifyToken, requireRole(allowed), patchPaymentStatus);

  // Owner / Admin only (same rule as penalties). Booking exists -> the whole booking is archived with it;
  // booking gone -> just this payment. Preview first (writes nothing), then DELETE[?force=true].
  app.get   ("/api/payments/:id/delete-preview", verifyToken, requireRole([roles.ADMIN, roles.OWNER]), previewDeleteHandler("payment"));
  app.delete("/api/payments/:id",                verifyToken, requireRole([roles.ADMIN, roles.OWNER]), deleteHandler("payment"));
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

  // One discount per booking, no edits and no re-sending (there is no correction route any more).
  // On a partial payment it comes off the remaining balance; on a full one PayMongo refunds it.
  app.patch("/api/payments/booking/:bookingID/discount", verifyToken, requireRole(allowed), discountPayment);

  // Only for a refund that couldn't go through PayMongo (money received in store): records the
  // in-store hand-back with its mode and reference number.
  app.patch("/api/payments/booking/:bookingID/refund-issued", verifyToken, requireRole(allowed), refundIssued);
};