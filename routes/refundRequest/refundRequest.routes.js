import { listRefundRequests, listDiscountRefunds, listDepositReturns, approveRefund, rejectRefund, manualRefundIssued, failedRefundHandedBack, retryScheduledRefundSend, syncBookingRefunds } from "../../controllers/refundRequest/refundRequest.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner — same access level as Payments
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerRefundRequestRoutes = (app) => {
  app.get("/api/refund-requests",              verifyToken, requireRole(allowed), listRefundRequests);
  // Discount refunds (money a staff discount sent back), shown next to the requests on the Refunds page.
  app.get("/api/refund-requests/discount-refunds", verifyToken, requireRole(allowed), listDiscountRefunds);
  // Security-deposit returns sent through PayMongo (pending / failed / refunded), same tabs.
  app.get("/api/refund-requests/deposit-returns", verifyToken, requireRole(allowed), listDepositReturns);
  app.patch("/api/refund-requests/:id/approve", verifyToken, requireRole(allowed), approveRefund);
  app.patch("/api/refund-requests/:id/reject",  verifyToken, requireRole(allowed), rejectRefund);
  // Staff confirm the in-person part of a refund (the balance PayMongo can't return) was handed back.
  app.patch("/api/refund-requests/:id/manual-issued", verifyToken, requireRole(allowed), manualRefundIssued);
  // Staff paid back, themselves, the part(s) PayMongo refused on a Failed request (cash / GCash / Maya / bank transfer).
  app.patch("/api/refund-requests/:id/failed-handback", verifyToken, requireRole(allowed), failedRefundHandedBack);
  // Staff re-send of a scheduled (same-day) refund whose automatic attempts failed.
  app.patch("/api/refund-requests/:id/retry-scheduled", verifyToken, requireRole(allowed), retryScheduledRefundSend);
  // Staff ask PayMongo for the final result of a booking's refund(s) that are still "Waiting for PayMongo"
  // (use this when the webhook never reached the customer backend).
  app.patch("/api/refund-requests/booking/:bookingID/sync-paymongo", verifyToken, requireRole(allowed), syncBookingRefunds);
  // NOTE: a car's upcoming bookings are now force-refunded/cancelled as one
  // batch, entirely server-side, inside PATCH /api/fleet/cars/:carID/status
  // (fleet.controller.js's changeCarStatus) — there's no standalone
  // "refund this one booking right now" endpoint anymore; firing outside
  // that one gated, OTP-verified batch would bypass the whole point of it.
};