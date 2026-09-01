import { listBookings, editBooking, deleteBooking, markDroppedOff, approveCancellation, rejectCancellation } from "../../controllers/booking/booking.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner — Driver deliberately excluded.
// This is a business decision (refund/dispatch implications), not
// something the driver on that trip decides themselves, even though
// they'll still see the notification land in their bell.
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerBookingRoutes = (app) => {
  app.get("/api/bookings",       verifyToken, requireRole(allowed), listBookings);
  app.patch("/api/bookings/:id", verifyToken, requireRole(allowed), editBooking);
  app.patch("/api/bookings/:id/dropoff", verifyToken, requireRole(allowed), markDroppedOff);
  app.patch("/api/bookings/:id/cancellation/approve", verifyToken, requireRole(allowed), approveCancellation);
  app.patch("/api/bookings/:id/cancellation/reject",  verifyToken, requireRole(allowed), rejectCancellation);
  app.delete("/api/bookings/:id",verifyToken, requireRole(allowed), deleteBooking);
};