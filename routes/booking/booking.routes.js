import { listBookings, editBooking, deleteBooking, markDroppedOff } from "../../controllers/booking/booking.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerBookingRoutes = (app) => {
  app.get("/api/bookings",       verifyToken, requireRole(allowed), listBookings);
  app.patch("/api/bookings/:id", verifyToken, requireRole(allowed), editBooking);
  app.patch("/api/bookings/:id/dropoff", verifyToken, requireRole(allowed), markDroppedOff);
  app.delete("/api/bookings/:id",verifyToken, requireRole(allowed), deleteBooking);
};