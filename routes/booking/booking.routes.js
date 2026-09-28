import { listBookings, editBooking, deleteBooking, markDroppedOff, deviceCheck, settleDepositHandler, returnChecklist, approveCancellation, rejectCancellation } from "../../controllers/booking/booking.controller.js";
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
  app.patch("/api/bookings/:id/device-check", verifyToken, requireRole(allowed), deviceCheck);
  app.patch("/api/bookings/:id/settle-deposit", verifyToken, requireRole(allowed), settleDepositHandler);
  app.get("/api/bookings/:id/return-checklist", verifyToken, requireRole(allowed), returnChecklist);
  app.patch("/api/bookings/:id/cancellation/approve", verifyToken, requireRole(allowed), approveCancellation);
  app.patch("/api/bookings/:id/cancellation/reject",  verifyToken, requireRole(allowed), rejectCancellation);
  app.delete("/api/bookings/:id",verifyToken, requireRole(allowed), deleteBooking);
};