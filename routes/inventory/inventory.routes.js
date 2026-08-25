import {
  getInventory,
  getNearestBooking,
  saveBefore,
  saveAfter,
  editHistoryPartStatus,
} from "../../controllers/inventory/inventory.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

// Editing past trip history — Admin only (see conversation this was built
// from: a direct edit, not a dual-value correction overlay, restricted to
// Admin rather than Owner/Supervisor too).
const editAllowed = [roles.ADMIN];

export const registerInventoryRoutes = (app) => {
  app.get("/api/inventory/booking/:bookingID",          verifyToken, requireRole(allowed), getInventory);
  app.get("/api/inventory/nearest-booking/:carID",      verifyToken, requireRole(allowed), getNearestBooking);
  app.post("/api/inventory/before-trip",                verifyToken, requireRole(allowed), saveBefore);
  app.post("/api/inventory/after-trip",                 verifyToken, requireRole(allowed), saveAfter);
  app.patch("/api/inventory/history/:tripPhase/:bookingID", verifyToken, requireRole(editAllowed), editHistoryPartStatus);
};