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
  getCarActiveSession,
  updateCarGeofence,
  getCarTraceback,
  getCarHistory,
  flushSessionNow,
} from "../../controllers/gps/gps.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Visible to: Owner, Supervisor, Admin
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerGpsRoutes = (app) => {
  // GPS device pushes location (no auth — device uses device_id as key)
  app.post("/api/gps", receiveLocation);

  // GPS device management — Owner, Admin, Supervisor
  app.get("/api/gps/devices",             verifyToken, requireRole(allowed), getAllGpsDevices);
  // Adding a device is Admin-only (the GPS Setup page hides the button for Owner/Supervisor; this enforces it).
  app.post("/api/gps/devices",            verifyToken, requireRole([roles.ADMIN]), addGpsDevice);
  app.put("/api/gps/devices/:id/assign",  verifyToken, requireRole(allowed), assignCarToDevice);
  app.put("/api/gps/devices/:id/unassign",verifyToken, requireRole(allowed), unassignDeviceFromCar);
  app.patch("/api/gps/devices/:id",       verifyToken, requireRole(allowed), updateGpsDevice);
  app.delete("/api/gps/devices/:id",      verifyToken, requireRole(allowed), deleteGpsDevice);

  // Car Tracking — Live / Traceback / History / geofence editing.
  // These were already being called by the frontend (CarTracking.jsx,
  // TracebackPanel.jsx, HistoryPanel.jsx) and already existed as exported
  // controller functions, but were never registered here — every one of
  // these routes was 404ing. Fixed.
  app.get("/api/gps/:carId/session",   verifyToken, requireRole(allowed), getCarActiveSession);
  app.patch("/api/gps/:carId/geofence",verifyToken, requireRole(allowed), updateCarGeofence);
  app.get("/api/gps/:carId/traceback", verifyToken, requireRole(allowed), getCarTraceback);
  app.get("/api/gps/:carId/history",   verifyToken, requireRole(allowed), getCarHistory);
  // Manual "flush now" for one trip (History tab) -- writes its archive file immediately instead of at midnight.
  app.post("/api/gps/sessions/:bookingSessionID/flush", verifyToken, requireRole(allowed), flushSessionNow);

  // Frontend reads locations — MUST be after /devices routes
  app.get("/api/gps",     verifyToken, requireRole(allowed), getAllDeviceLocations);
  app.get("/api/gps/:id", verifyToken, requireRole(allowed), getDeviceLocation);
};