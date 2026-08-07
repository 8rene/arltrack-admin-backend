import { getBoard, assign, unassign } from "../../controllers/driverDispatch/driverDispatch.controller.js";
import { verifyToken }        from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Owner + Admin + Supervisor — matches frontend/src/config/pagePermissions.js:
// "/driver-dispatch". Keep these two in sync by hand (same caveat every
// other route file in this app has).
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerDriverDispatchRoutes = (app) => {
  app.get ("/api/driver-dispatch/board",    verifyToken, requireRole(allowed), getBoard);
  app.post("/api/driver-dispatch/assign",   verifyToken, requireRole(allowed), assign);
  app.post("/api/driver-dispatch/unassign", verifyToken, requireRole(allowed), unassign);
};