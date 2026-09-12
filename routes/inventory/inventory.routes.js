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

// Editing past trip history — was Admin-only. Opened up to Owner/Supervisor
// too so it matches Maintenance.jsx's own access level: since that page's
// "Mark Replaced" button now calls this endpoint to persist a resolved
// damaged/stolen/missing part, restricting it to Admin would silently 403
// for 2 of the 3 roles that can see that button.
const editAllowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerInventoryRoutes = (app) => {
  app.get("/api/inventory/booking/:bookingID",          verifyToken, requireRole(allowed), getInventory);
  app.get("/api/inventory/nearest-booking/:carID",      verifyToken, requireRole(allowed), getNearestBooking);
  app.post("/api/inventory/before-trip",                verifyToken, requireRole(allowed), saveBefore);
  app.post("/api/inventory/after-trip",                 verifyToken, requireRole(allowed), saveAfter);
  app.patch("/api/inventory/history/:tripPhase/:bookingID", verifyToken, requireRole(editAllowed), editHistoryPartStatus);
};