import { listBookings, editBooking, deleteBooking, deleteBookingPreview, markDroppedOff, settleDepositHandler, retryDepositReturnHandler, handBackDepositReturnHandler, returnChecklist, approveCancellation, rejectCancellation, refundPreview, refundAndCancel, markNoShow } from "../../controllers/booking/booking.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner. A Driver reaches the equivalent
// dropoff/return actions through their own ownership-checked routes under
// /api/driver-dispatch/my-trips/:id/... instead (see driverDispatch.routes.js)
// — deliberately separate so a driver can only ever act on their own
// assigned booking, never any booking via this admin-wide route.
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerBookingRoutes = (app) => {
  app.get("/api/bookings",       verifyToken, requireRole(allowed), listBookings);
  app.patch("/api/bookings/:id", verifyToken, requireRole(allowed), editBooking);
  app.patch("/api/bookings/:id/dropoff", verifyToken, requireRole(allowed), markDroppedOff);
  app.patch("/api/bookings/:id/settle-deposit", verifyToken, requireRole(allowed), settleDepositHandler);
  // An online deposit return PayMongo refused: retry it, or record the in-store hand-back instead.
  app.patch("/api/bookings/:id/deposit-return/retry", verifyToken, requireRole(allowed), retryDepositReturnHandler);
  app.patch("/api/bookings/:id/deposit-return/handback", verifyToken, requireRole(allowed), handBackDepositReturnHandler);
  app.get("/api/bookings/:id/return-checklist", verifyToken, requireRole(allowed), returnChecklist);
  app.patch("/api/bookings/:id/cancellation/approve", verifyToken, requireRole(allowed), approveCancellation);
  app.patch("/api/bookings/:id/cancellation/reject",  verifyToken, requireRole(allowed), rejectCancellation);
  // Money-moving, so Admin/Owner only (Supervisors can still approve a customer's
  // own refund request from the Refund Requests page).
  app.get("/api/bookings/:id/refund-preview", verifyToken, requireRole([roles.ADMIN, roles.OWNER]), refundPreview);
  app.post("/api/bookings/:id/refund-cancel", verifyToken, requireRole([roles.ADMIN, roles.OWNER]), refundAndCancel);
  // No-show after the pickup time: deposit kept, everything else refunded (see refundRequest.service.js → markBookingNoShow).
  app.post("/api/bookings/:id/no-show", verifyToken, requireRole([roles.ADMIN, roles.OWNER]), markNoShow);
  // Supervisor, Admin, Owner. Preview first (what goes + what is in the way); only Owner/Admin can force past blockers.
  app.get("/api/bookings/:id/delete-preview", verifyToken, requireRole(allowed), deleteBookingPreview);
  app.delete("/api/bookings/:id",verifyToken, requireRole(allowed), deleteBooking);
};