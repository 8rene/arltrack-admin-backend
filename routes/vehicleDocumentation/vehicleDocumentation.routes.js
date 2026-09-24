import {
  getVehicleDocs,
  saveBeforeTrip,
  saveAfterTrip,
  saveInventoryStatusHandler,
  editHistoryPhoto,
} from "../../controllers/vehicleDocumentation/vehicleDocumentation.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin — Driver deliberately excluded.
// Vehicle inspection is a staff responsibility now: a Driver can neither
// read nor write it (this used to be Driver-inclusive with a per-booking
// ownership check). A Driver's Pickup/Return is instead GATED on staff
// having completed it — see hasCompleteBeforeTripDocs/AfterTripDocs in
// vehicleDocumentation.service.js, enforced in booking.service.js's
// updateBooking, which the driver's My Trips actions go through.
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

// Editing/replacing past-trip photos — Admin only, same as the parts
// status edit (see inventory.routes.js).
const editAllowed = [roles.ADMIN];

export const registerVehicleDocsRoutes = (app) => {
  app.get("/api/vehicle-docs/booking/:bookingID",   verifyToken, requireRole(allowed), getVehicleDocs);
  app.post("/api/vehicle-docs/before-trip",         verifyToken, requireRole(allowed), saveBeforeTrip);
  app.post("/api/vehicle-docs/after-trip",          verifyToken, requireRole(allowed), saveAfterTrip);
  app.put("/api/vehicle-docs/inventory-status",     verifyToken, requireRole(allowed), saveInventoryStatusHandler);
  app.patch("/api/vehicle-docs/history/:tripPhase/:bookingID", verifyToken, requireRole(editAllowed), editHistoryPhoto);
};