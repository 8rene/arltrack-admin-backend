import {
  listBookingArchives,
  restoreBookingArchiveHandler,
  deleteBookingArchiveHandler,
} from "../../controllers/archives/bookingArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerBookingArchiveRoutes = (app) => {
  // GET    /api/archives/bookings
  app.get("/api/archives/bookings", verifyToken, listBookingArchives);

  // POST   /api/archives/bookings/:bookingArchivesId/restore
  app.post("/api/archives/bookings/:bookingArchivesId/restore", verifyToken, restoreBookingArchiveHandler);

  // DELETE /api/archives/bookings/:bookingArchivesId
  app.delete("/api/archives/bookings/:bookingArchivesId", verifyToken, deleteBookingArchiveHandler);
};
