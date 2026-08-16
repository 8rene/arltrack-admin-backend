import {
  updateUserDocument,
  approveProfile,
  approveIdResubmit,
  rejectReviewRequest,
  updateOwnProfileFields,
  submitEditRequest,
  cancelOwnEditRequest,
  submitIdResubmitRequest,
} from "../../controllers/profileRequests/profileRequests.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Matches Users.jsx's Documents / Edit Request sub-tabs — broadest of the
// tabs that use these actions is [Owner, Admin, Supervisor] (Customer/
// Driver tabs); the narrower Supervisor tab ([Owner, Admin]) is still
// covered since it's a subset. Same reasoning as editAllowed in
// user.routes.js.
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerProfileRequestsRoutes = (app) => {
  app.put   ("/api/users/:uid/document",              verifyToken, requireRole(allowed), updateUserDocument);
  app.post  ("/api/edit-requests/:id/approve",         verifyToken, requireRole(allowed), approveProfile);
  app.post  ("/api/id-resubmit-requests/:id/approve",  verifyToken, requireRole(allowed), approveIdResubmit);
  app.patch ("/api/review-requests/:kind/:id/reject",  verifyToken, requireRole(allowed), rejectReviewRequest);

  // ── Self-service (Profile.jsx / Account.jsx) ────────────────────
  // No role restriction beyond being logged in — these all act on the
  // caller's own account, identity taken from the verified token.
  app.put   ("/api/profile/fields",                    verifyToken, updateOwnProfileFields);
  app.post  ("/api/profile/edit-requests",              verifyToken, submitEditRequest);
  app.patch ("/api/profile/edit-requests/:id/cancel",   verifyToken, cancelOwnEditRequest);
  app.post  ("/api/profile/id-resubmit-requests",        verifyToken, submitIdResubmitRequest);
};