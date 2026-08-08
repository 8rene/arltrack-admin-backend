import {
  getVehicleDocs,
  saveBeforeTrip,
  saveAfterTrip,
} from "../../controllers/vehicleDocumentation/vehicleDocumentation.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin, and Driver (Driver is
// ownership-checked per-request in the controller above — ROLE_LIST_
// VIEWABLE_BY-style role gating alone isn't enough here since a Driver
// must only reach their OWN booking's docs, not the fleet's).
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN, roles.DRIVER];

export const registerVehicleDocsRoutes = (app) => {
  app.get("/api/vehicle-docs/booking/:bookingID", verifyToken, requireRole(allowed), getVehicleDocs);
  app.post("/api/vehicle-docs/before-trip",       verifyToken, requireRole(allowed), saveBeforeTrip);
  app.post("/api/vehicle-docs/after-trip",        verifyToken, requireRole(allowed), saveAfterTrip);
};