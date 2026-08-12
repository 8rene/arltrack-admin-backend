import { getBoard, assign, unassign, getMine, getMyHistory, myPickup, myDropoff, myReturn, myCollectBalance, myConfirmPayment, myRefundIssued } from "../../controllers/driverDispatch/driverDispatch.controller.js";
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
  app.post("/api/driver-dispatch/assign",   verifyToken, requireRole(allowed), assign);
  app.post("/api/driver-dispatch/unassign", verifyToken, requireRole(allowed), unassign);

  app.get  ("/api/driver-dispatch/my-trips",          verifyToken, requireRole(driverOnly), getMine);
  app.get  ("/api/driver-dispatch/my-trips/history",   verifyToken, requireRole(driverOnly), getMyHistory);
  app.patch("/api/driver-dispatch/my-trips/:id/pickup",  verifyToken, requireRole(driverOnly), myPickup);
  app.patch("/api/driver-dispatch/my-trips/:id/dropoff", verifyToken, requireRole(driverOnly), myDropoff);
  app.patch("/api/driver-dispatch/my-trips/:id/return",  verifyToken, requireRole(driverOnly), myReturn);
  app.patch("/api/driver-dispatch/my-trips/:id/collect-balance", verifyToken, requireRole(driverOnly), myCollectBalance);
  // Confirm a cash/in-person initial payment right at pickup — driver
  // never needs Payments page access for this.
  app.patch("/api/driver-dispatch/my-trips/:id/confirm-payment", verifyToken, requireRole(driverOnly), myConfirmPayment);
  // Driver confirming they handed back a refund-due amount (created when
  // a staff discount overshot the balance) — they're usually the one
  // physically holding the cash. See payments routes for the staff
  // equivalent of this same action.
  app.patch("/api/driver-dispatch/my-trips/:id/refund-issued", verifyToken, requireRole(driverOnly), myRefundIssued);
};