import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";
import { deleteUser, getUserByUid, getUserDetails } from "../../controllers/user/user.controller.js";

// Visible to: Admin only (user management)
const allowed = [roles.ADMIN];

export const registerUserRoutes = (app) => {
  app.delete("/api/users/:uid",          verifyToken, requireRole(allowed), deleteUser);
  app.get("/api/users/by-uid/:uid",      verifyToken, requireRole(allowed), getUserByUid);
  app.get("/api/users/details/:uid",     verifyToken, requireRole(allowed), getUserDetails);
};