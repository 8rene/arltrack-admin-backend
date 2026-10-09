import {
  getLateFeePreview,
  getBookingPenalties,
  postCreatePenalty,
  patchVoidOrWaivePenalty,
  postWaiveDeposit,
  postSettleBooking,
  postShortfallPayment,
  getAllPenaltiesHandler,
} from "../../controllers/penalty/penalty.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Staff (any role that can operate the front desk) can create a penalty
// and view — creating one confirms it immediately and notifies the
// customer, there's no Draft queue for a supervisor to review first
// anymore (see penalty.service.js's createPenalty for what replaced that
// review step). Only Supervisor+ can void/waive, record/waive a deposit,
// or settle a booking.
const staff      = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR, roles.DRIVER];
const supervisor = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerPenaltyRoutes = (app) => {
  // Every penalty in the system — supervisor and above only. A Driver's own
  // trips are covered by the booking-scoped routes below instead.
  app.get ("/api/penalties",                              verifyToken, requireRole(supervisor), getAllPenaltiesHandler);
  app.get ("/api/penalties/late-fee-preview/:bookingID", verifyToken, requireRole(staff), getLateFeePreview);
  app.get ("/api/penalties/booking/:bookingID",           verifyToken, requireRole(staff), getBookingPenalties);

  app.post ("/api/penalties",                   verifyToken, requireRole(staff),      postCreatePenalty);
  app.patch("/api/penalties/:penaltyID/status", verifyToken, requireRole(supervisor), patchVoidOrWaivePenalty);

  app.post("/api/penalties/deposit/waive",    verifyToken, requireRole(supervisor), postWaiveDeposit);

  app.post("/api/penalties/booking/:bookingID/settle", verifyToken, requireRole(supervisor), postSettleBooking);
  app.post("/api/penalties/shortfall-payment",         verifyToken, requireRole(supervisor), postShortfallPayment);
};