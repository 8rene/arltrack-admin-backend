import {
  listBookingArchives,
  restoreBookingArchiveHandler,
  deleteBookingArchiveHandler,
  getLinkedPaymentArchiveHandler,
  getLinkedVehicleInspectionHandler,
  getLinkedBookingSessionHandler,
} from "../../controllers/archives/bookingArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

export const registerBookingArchiveRoutes = (app) => {
  app.get("/api/archives/bookings",                                    verifyToken, requireRole(allowed), listBookingArchives);
  app.post("/api/archives/bookings/:bookingArchivesId/restore",        verifyToken, requireRole(allowed), restoreBookingArchiveHandler);
  app.delete("/api/archives/bookings/:bookingArchivesId",              verifyToken, requireRole(deleteAllowed), deleteBookingArchiveHandler);

  // "View Payment" / "View Vehicle Inspection" / "View Booking Session"
  // modals on the Booking Archive page — read-only, same access level as
  // viewing the archive itself (Owner + Admin).
  app.get("/api/archives/bookings/:bookingArchivesId/payment",             verifyToken, requireRole(allowed), getLinkedPaymentArchiveHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/vehicle-inspection",  verifyToken, requireRole(allowed), getLinkedVehicleInspectionHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/booking-session",     verifyToken, requireRole(allowed), getLinkedBookingSessionHandler);
};