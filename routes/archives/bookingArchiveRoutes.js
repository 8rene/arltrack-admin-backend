import {
  listBookingArchives,
  restoreBookingArchiveHandler,
  deleteBookingArchiveHandler,
} from "../../controllers/archives/bookingArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only
const allowed = [roles.OWNER, roles.ADMIN];

export const registerBookingArchiveRoutes = (app) => {
  app.get("/api/archives/bookings",                                    verifyToken, requireRole(allowed), listBookingArchives);
  app.post("/api/archives/bookings/:bookingArchivesId/restore",        verifyToken, requireRole(allowed), restoreBookingArchiveHandler);
  app.delete("/api/archives/bookings/:bookingArchivesId",              verifyToken, requireRole(allowed), deleteBookingArchiveHandler);
};