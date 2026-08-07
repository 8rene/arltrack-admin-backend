import {
  getInventory,
  getNearestBooking,
  saveBefore,
  saveAfter,
} from "../../controllers/inventory/inventory.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerInventoryRoutes = (app) => {
  app.get("/api/inventory/booking/:bookingID",          verifyToken, requireRole(allowed), getInventory);
  app.get("/api/inventory/nearest-booking/:carID",      verifyToken, requireRole(allowed), getNearestBooking);
  app.post("/api/inventory/before-trip",                verifyToken, requireRole(allowed), saveBefore);
  app.post("/api/inventory/after-trip",                 verifyToken, requireRole(allowed), saveAfter);
};