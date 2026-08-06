import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";
import { deleteUser, getUserByUid, getUserDetails, getUsersByRole } from "../../controllers/user/user.controller.js";

// Visible to: Admin only (user management)
const allowed = [roles.ADMIN];

// Broader at the route level — getUsersByRole checks per-target-role
// permission itself (ROLE_LIST_VIEWABLE_BY in role.util.js), since "can
// view Driver list" and "can view Admin list" are different permissions
// that a single flat allowed[] here can't express.
const listAllowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];

export const registerUserRoutes = (app) => {
  app.get("/api/users",                  verifyToken, requireRole(listAllowed), getUsersByRole);
  app.delete("/api/users/:uid",          verifyToken, requireRole(allowed), deleteUser);
  app.get("/api/users/by-uid/:uid",      verifyToken, requireRole(allowed), getUserByUid);
  app.get("/api/users/details/:uid",     verifyToken, requireRole(allowed), getUserDetails);
};