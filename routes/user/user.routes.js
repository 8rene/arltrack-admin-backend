import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";
import { deleteUser, getUserByUid, getUserDetails, getUsersByRole, updateUserRole } from "../../controllers/user/user.controller.js";

// Visible to: Admin only (user management)
const allowed = [roles.ADMIN];

// Delete/archive is one step further up the trust chain — Owner gets it
// too, on top of Admin. Kept as its own array (rather than widening
// `allowed`) so this doesn't also loosen role-editing, which is meant to
// stay Admin-only.
const deleteAllowed = [roles.OWNER, roles.ADMIN];

// Broader at the route level — getUsersByRole checks per-target-role
// permission itself (ROLE_LIST_VIEWABLE_BY in role.util.js), since "can
// view Driver list" and "can view Admin list" are different permissions
// that a single flat allowed[] here can't express.
const listAllowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerUserRoutes = (app) => {
  app.get("/api/users",                  verifyToken, requireRole(listAllowed), getUsersByRole);
  app.delete("/api/users/:uid",          verifyToken, requireRole(deleteAllowed), deleteUser);
  app.get("/api/users/by-uid/:uid",      verifyToken, requireRole(allowed), getUserByUid);
  app.get("/api/users/details/:uid",     verifyToken, requireRole(allowed), getUserDetails);
  app.patch("/api/users/:uid/role",      verifyToken, requireRole(allowed), updateUserRole);
};