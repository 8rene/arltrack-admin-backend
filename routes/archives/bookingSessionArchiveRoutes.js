import {
  listBookingSessionArchives,
  restoreBookingSessionArchiveHandler,
  deleteBookingSessionArchiveHandler,
} from "../../controllers/archives/bookingSessionArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Archives visible to: Owner only — same access level as every other archive
const allowed = [roles.OWNER];

export const registerBookingSessionArchiveRoutes = (app) => {
  app.get("/api/archives/booking-sessions",                                          verifyToken, requireRole(allowed), listBookingSessionArchives);
  app.post("/api/archives/booking-sessions/:bookingSessionArchivesId/restore",       verifyToken, requireRole(allowed), restoreBookingSessionArchiveHandler);
  app.delete("/api/archives/booking-sessions/:bookingSessionArchivesId",             verifyToken, requireRole(allowed), deleteBookingSessionArchiveHandler);
};