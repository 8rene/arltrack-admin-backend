import {
  getLateFeePreview,
  getBookingPenalties,
  getDraftQueue,
  postDraftPenalty,
  patchDraftPenalty,
  postConfirmPenalty,
  patchVoidOrWaivePenalty,
  postDepositReceived,
  postWaiveDeposit,
  postSettleBooking,
  postShortfallPayment,
} from "../../controllers/penalty/penalty.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Staff (any role that can operate the front desk) can draft and view.
// Only Supervisor+ can confirm, void/waive, record/waive a deposit, or
// settle a booking — matches the "supervisor decides, staff drafts" split
// from the design.
const staff      = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR, roles.DRIVER];
const supervisor = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerPenaltyRoutes = (app) => {
  app.get ("/api/penalties/late-fee-preview/:bookingID", verifyToken, requireRole(staff), getLateFeePreview);
  app.get ("/api/penalties/booking/:bookingID",           verifyToken, requireRole(staff), getBookingPenalties);
  app.get ("/api/penalties/queue",                        verifyToken, requireRole(staff), getDraftQueue);

  app.post ("/api/penalties",                    verifyToken, requireRole(staff), postDraftPenalty);
  app.patch("/api/penalties/:penaltyID",          verifyToken, requireRole(staff), patchDraftPenalty);
  app.post ("/api/penalties/:penaltyID/confirm",  verifyToken, requireRole(supervisor), postConfirmPenalty);
  app.patch("/api/penalties/:penaltyID/status",   verifyToken, requireRole(supervisor), patchVoidOrWaivePenalty);

  app.post("/api/penalties/deposit/received", verifyToken, requireRole(staff),      postDepositReceived);
  app.post("/api/penalties/deposit/waive",    verifyToken, requireRole(supervisor), postWaiveDeposit);

  app.post("/api/penalties/booking/:bookingID/settle", verifyToken, requireRole(supervisor), postSettleBooking);
  app.post("/api/penalties/shortfall-payment",         verifyToken, requireRole(supervisor), postShortfallPayment);
};