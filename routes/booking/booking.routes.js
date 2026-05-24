import { listBookings, editBooking, deleteBooking } from "../../controllers/booking/booking.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerBookingRoutes = (app) => {
  app.get("/api/bookings", verifyToken, listBookings);
  app.patch("/api/bookings/:id", verifyToken, editBooking);
  app.delete("/api/bookings/:id", verifyToken, deleteBooking);  // ← cascading archive + delete
};
