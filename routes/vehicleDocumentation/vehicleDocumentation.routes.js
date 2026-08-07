import {
  getVehicleDocs,
  saveBeforeTrip,
  saveAfterTrip,
} from "../../controllers/vehicleDocumentation/vehicleDocumentation.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerVehicleDocsRoutes = (app) => {
  app.get("/api/vehicle-docs/booking/:bookingID", verifyToken, requireRole(allowed), getVehicleDocs);
  app.post("/api/vehicle-docs/before-trip",       verifyToken, requireRole(allowed), saveBeforeTrip);
  app.post("/api/vehicle-docs/after-trip",        verifyToken, requireRole(allowed), saveAfterTrip);
};