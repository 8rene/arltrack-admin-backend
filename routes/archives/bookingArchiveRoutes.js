import {
  listBookingArchives,
  getBookingArchiveDetailsHandler,
  restoreBookingArchiveHandler,
  deleteBookingArchiveHandler,
  getLinkedPaymentArchiveHandler,
  getLinkedVehicleInspectionHandler,
  getLinkedBookingSessionHandler,
  getLinkedPenaltiesHandler,
  getLinkedRefundRequestsHandler,
  getLinkedReviewsHandler,
  getLinkedMaintenanceHandler,
} from "../../controllers/archives/bookingArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View + restore: Owner and Admin. Permanent delete: Owner only
// (irreversible, so kept out of Admin's reach even if that account is compromised).
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER]; // Owner only: a delete always takes the whole booking (payments, penalties, refunds, files) while its booking archive exists

export const registerBookingArchiveRoutes = (app) => {
  app.get("/api/archives/bookings",                                    verifyToken, requireRole(allowed), listBookingArchives);
  app.post("/api/archives/bookings/:bookingArchivesId/restore",        verifyToken, requireRole(allowed), restoreBookingArchiveHandler);
  app.delete("/api/archives/bookings/:bookingArchivesId",              verifyToken, requireRole(deleteAllowed), deleteBookingArchiveHandler);

  // "View Payment" / "View Vehicle Inspection" / "View Booking Session"
  // modals on the Booking Archive page — read-only, same access level as
  // viewing the archive itself (Owner + Admin).
  app.get("/api/archives/bookings/:bookingArchivesId/details",             verifyToken, requireRole(allowed), getBookingArchiveDetailsHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/payment",             verifyToken, requireRole(allowed), getLinkedPaymentArchiveHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/vehicle-inspection",  verifyToken, requireRole(allowed), getLinkedVehicleInspectionHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/booking-session",     verifyToken, requireRole(allowed), getLinkedBookingSessionHandler);
  // Lists (a booking can have several of each): penalties, refund requests, reviews, maintenance records.
  app.get("/api/archives/bookings/:bookingArchivesId/penalties",           verifyToken, requireRole(allowed), getLinkedPenaltiesHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/refund-requests",     verifyToken, requireRole(allowed), getLinkedRefundRequestsHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/reviews",             verifyToken, requireRole(allowed), getLinkedReviewsHandler);
  app.get("/api/archives/bookings/:bookingArchivesId/maintenance",         verifyToken, requireRole(allowed), getLinkedMaintenanceHandler);
};