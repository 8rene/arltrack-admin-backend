import {
  getLateFeePreview,
  getBookingPenalties,
  postCreatePenalty,
  patchVoidOrWaivePenalty,
  patchEditPenalty,
  postConfirmPenalty,
  postWaiveDeposit,
  postSettleBooking,
  postShortfallPayment,
  getAllPenaltiesHandler,
} from "../../controllers/penalty/penalty.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Staff (any role that can operate the front desk) can create a penalty
// and view. What happens next depends on who creates it (see
// postCreatePenalty): Supervisor+ confirms it immediately and the customer
// is notified; a Driver's goes UnderReview — not notified — until a
// Supervisor+ edits/confirms it. Only Supervisor+ can edit/confirm a penalty
// under review, void/waive, record/waive a deposit, or settle a booking.
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
  app.patch("/api/penalties/:penaltyID",        verifyToken, requireRole(supervisor), patchEditPenalty);     // only while UnderReview
  app.post ("/api/penalties/:penaltyID/confirm", verifyToken, requireRole(supervisor), postConfirmPenalty);  // notifies the customer

  app.post("/api/penalties/deposit/waive",    verifyToken, requireRole(supervisor), postWaiveDeposit);

  app.post("/api/penalties/booking/:bookingID/settle", verifyToken, requireRole(supervisor), postSettleBooking);
  app.post("/api/penalties/shortfall-payment",         verifyToken, requireRole(supervisor), postShortfallPayment);
};