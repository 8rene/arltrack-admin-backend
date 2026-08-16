import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";
import { deleteUser, getUserByUid, getUserDetails, getUsersByRole, updateUserRole, verifyUserDocument, updateUserStatus } from "../../controllers/user/user.controller.js";

// Visible to: Admin only (user management)
const allowed = [roles.ADMIN];

// Delete/archive is one step further up the trust chain — Owner gets it
// too, on top of Admin. Kept as its own array (rather than widening
// `allowed`) so this doesn't also loosen the other Admin-only endpoints
// below (by-uid, details) by accident.
const deleteAllowed = [roles.OWNER, roles.ADMIN];

// Role-editing: same reasoning as deleteAllowed above — Owner gets this
// too, on top of Admin, but kept as its own array so `allowed` (the other
// Admin-only endpoints below) doesn't get loosened by accident.
const roleAllowed = [roles.OWNER, roles.ADMIN];

// Broader at the route level — getUsersByRole checks per-target-role
// permission itself (ROLE_LIST_VIEWABLE_BY in role.util.js), since "can
// view Driver list" and "can view Admin list" are different permissions
// that a single flat allowed[] here can't express.
const listAllowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

// verify/status: matches the Customer tab's own visibleTo in Users.jsx /
// pagePermissions.js ([Owner, Admin, Supervisor]) — these two actions are
// used from both the Customers tab and the Users page's Driver tab, both
// of which share that same access level.
const editAllowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerUserRoutes = (app) => {
  app.get("/api/users",                  verifyToken, requireRole(listAllowed), getUsersByRole);
  app.delete("/api/users/:uid",          verifyToken, requireRole(deleteAllowed), deleteUser);
  app.get("/api/users/by-uid/:uid",      verifyToken, requireRole(allowed), getUserByUid);
  app.get("/api/users/details/:uid",     verifyToken, requireRole(allowed), getUserDetails);
  app.patch("/api/users/:uid/role",      verifyToken, requireRole(roleAllowed), updateUserRole);
  app.patch("/api/users/:uid/verify",    verifyToken, requireRole(editAllowed), verifyUserDocument);
  app.patch("/api/users/:uid/status",    verifyToken, requireRole(editAllowed), updateUserStatus);
};