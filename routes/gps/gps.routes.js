import {
  receiveLocation,
  getDeviceLocation,
  getAllDeviceLocations,
  getAllGpsDevices,
  addGpsDevice,
  assignCarToDevice,
} from "../../controllers/gps/gps.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin
const allowed = [roles.SUPERVISOR, roles.ADMIN];

export const registerGpsRoutes = (app) => {
  // GPS device pushes location (no auth — device uses device_id as key)
  app.post("/api/gps", receiveLocation);

  // GPS device management — Admin, Supervisor only
  app.get("/api/gps/devices",             verifyToken, requireRole(allowed), getAllGpsDevices);
  app.post("/api/gps/devices",            verifyToken, requireRole(allowed), addGpsDevice);
  app.put("/api/gps/devices/:id/assign",  verifyToken, requireRole(allowed), assignCarToDevice);

  // Frontend reads locations — MUST be after /devices routes
  app.get("/api/gps",     verifyToken, requireRole(allowed), getAllDeviceLocations);
  app.get("/api/gps/:id", verifyToken, requireRole(allowed), getDeviceLocation);
};