import {
  listBookingSessionArchives,
  restoreBookingSessionArchiveHandler,
  deleteBookingSessionArchiveHandler,
} from "../../controllers/archives/bookingSessionArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerBookingSessionArchiveRoutes = (app) => {
  app.get("/api/archives/booking-sessions",                                          verifyToken, requireRole(allowed), listBookingSessionArchives);
  app.post("/api/archives/booking-sessions/:bookingSessionArchivesId/restore",       verifyToken, requireRole(allowed), restoreBookingSessionArchiveHandler);
  app.delete("/api/archives/booking-sessions/:bookingSessionArchivesId",             verifyToken, requireRole(deleteAllowed), deleteBookingSessionArchiveHandler);
};