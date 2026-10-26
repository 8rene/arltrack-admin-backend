import {
  updateUserDocument,
  adminUpdateProfile,
  adminReplaceDocument,
  approveProfile,
  approveIdResubmit,
  rejectReviewRequest,
  updateOwnProfileFields,
  updateOwnDocument,
  updateOwnAvatar,
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

// updateOwnDocument applies a license/document change directly with no
// review step — same trust boundary as canEditDirectly on the frontend,
// so it's restricted to Owner/Admin server-side too, not just hidden in
// the UI. A Driver/Supervisor calling this endpoint directly (bypassing
// Profile.jsx's role check) would otherwise skip review entirely.
const ownerAdminOnly = [roles.OWNER, roles.ADMIN];

export const registerProfileRequestsRoutes = (app) => {
  // Editing another user's profile or documents is an Admin job: Owner/Admin only. Supervisors can still view and approve/reject
  // (verify endpoint in user.routes.js) but can no longer change expiry/number or replace photos.
  app.put   ("/api/users/:uid/document",              verifyToken, requireRole(ownerAdminOnly), updateUserDocument);
  app.put   ("/api/users/:uid/document/replace",      verifyToken, requireRole(ownerAdminOnly), adminReplaceDocument);
  app.put   ("/api/users/:uid/profile",               verifyToken, requireRole(ownerAdminOnly), adminUpdateProfile);
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
  app.put   ("/api/profile/document",                   verifyToken, requireRole(ownerAdminOnly), updateOwnDocument);
  app.put   ("/api/profile/avatar",                     verifyToken, updateOwnAvatar);
};