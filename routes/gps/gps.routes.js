import {
  receiveLocation,
  getDeviceLocation,
  getAllDeviceLocations,
  getAllGpsDevices,
  addGpsDevice,
  assignCarToDevice,
  unassignDeviceFromCar,
  updateGpsDevice,
  deleteGpsDevice,
  getCarTraceback,
  getCarHistory,
  getCarActiveSession,
  updateCarGeofence,
} from "../../controllers/gps/gps.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Supervisor, Admin, Owner
const allowed = [roles.SUPERVISOR, roles.ADMIN, roles.OWNER];

export const registerGpsRoutes = (app) => {
  // GPS device pushes location (no auth — device uses device_id as key)
  app.post("/api/gps", receiveLocation);

  // GPS device management — Admin, Supervisor, Owner only
  app.get("/api/gps/devices",             verifyToken, requireRole(allowed), getAllGpsDevices);
  app.post("/api/gps/devices",            verifyToken, requireRole(allowed), addGpsDevice);
  app.put("/api/gps/devices/:id/assign",  verifyToken, requireRole(allowed), assignCarToDevice);
  app.put("/api/gps/devices/:id/unassign",verifyToken, requireRole(allowed), unassignDeviceFromCar);
  app.patch("/api/gps/devices/:id",       verifyToken, requireRole(allowed), updateGpsDevice);
  app.delete("/api/gps/devices/:id",      verifyToken, requireRole(allowed), deleteGpsDevice);

  // Car Tracking — Traceback (per-car, per-date trail) & History (list of archived trips)
  // MUST be registered before /api/gps/:id since both start with /api/gps/<param>,
  // but these have an extra path segment so they never actually collide with it —
  // kept together here for readability, not because order matters for these two.
  app.get("/api/gps/:carId/traceback", verifyToken, requireRole(allowed), getCarTraceback);
  app.get("/api/gps/:carId/history",   verifyToken, requireRole(allowed), getCarHistory);
  app.get("/api/gps/:carId/session",   verifyToken, requireRole(allowed), getCarActiveSession);
  app.patch("/api/gps/:carId/geofence",verifyToken, requireRole(allowed), updateCarGeofence);

  // Frontend reads locations — MUST be after /devices routes
  app.get("/api/gps",     verifyToken, requireRole(allowed), getAllDeviceLocations);
  app.get("/api/gps/:id", verifyToken, requireRole(allowed), getDeviceLocation);
};