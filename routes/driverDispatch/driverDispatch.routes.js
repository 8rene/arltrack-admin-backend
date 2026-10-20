import { getBoard, assign, unassign, getAvailability, getMine, getMyHistory, getMyInspection, getActivityForDriver, myPickup, myDropoff, myRemindInspection, myCreatePenalty, myOnMyWay, myRemindBalance } from "../../controllers/driverDispatch/driverDispatch.controller.js";
import { verifyToken }        from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Owner + Admin + Supervisor — matches frontend/src/config/pagePermissions.js:
// "/driver-dispatch". Keep these two in sync by hand (same caveat every
// other route file in this app has).
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

// Driver-only, separate array on purpose — these hit /my-trips endpoints,
// which are ownership-checked per-request in driverDispatch.service.js
// (req.user.uid), not role-gated the way the board above is. A Driver
// should never be able to reach the dispatch board itself.
const driverOnly = [roles.DRIVER];

export const registerDriverDispatchRoutes = (app) => {
  app.get ("/api/driver-dispatch/board",    verifyToken, requireRole(allowed), getBoard);
  app.get ("/api/driver-dispatch/availability", verifyToken, requireRole(allowed), getAvailability);
  app.get ("/api/driver-dispatch/drivers/:driverID/activity", verifyToken, requireRole(allowed), getActivityForDriver);
  app.post("/api/driver-dispatch/assign",   verifyToken, requireRole(allowed), assign);
  app.post("/api/driver-dispatch/unassign", verifyToken, requireRole(allowed), unassign);

  app.get  ("/api/driver-dispatch/my-trips",          verifyToken, requireRole(driverOnly), getMine);
  app.get  ("/api/driver-dispatch/my-trips/history",   verifyToken, requireRole(driverOnly), getMyHistory);
  // Read-only before/after inspection proof for the driver's OWN booking
  // (ownership-checked in the service). Writes stay staff-only.
  app.get  ("/api/driver-dispatch/my-trips/:id/inspection", verifyToken, requireRole(driverOnly), getMyInspection);
  app.patch("/api/driver-dispatch/my-trips/:id/pickup",  verifyToken, requireRole(driverOnly), myPickup);
  app.patch("/api/driver-dispatch/my-trips/:id/dropoff", verifyToken, requireRole(driverOnly), myDropoff);
  app.post ("/api/driver-dispatch/my-trips/:id/penalty",          verifyToken, requireRole(driverOnly), myCreatePenalty);
  // Driver is blocked at Pickup because staff haven't finished the
  // vehicle inspection yet — nudges Owner/Admin/Supervisor via the bell.
  // Server-side 10-minute cooldown per booking.
  // Drivers can only pick up and drop off — return/completion and all
  // payment actions are staff-only (Car Tracking / Payments).
  app.post ("/api/driver-dispatch/my-trips/:id/remind-inspection", verifyToken, requireRole(driverOnly), myRemindInspection);
  // Heading to the customer's pickup location (NOT Start Pickup) — notifies the customer; and the balance nudge.
  app.patch("/api/driver-dispatch/my-trips/:id/on-my-way",       verifyToken, requireRole(driverOnly), myOnMyWay);
  app.post ("/api/driver-dispatch/my-trips/:id/remind-balance",  verifyToken, requireRole(driverOnly), myRemindBalance);
};