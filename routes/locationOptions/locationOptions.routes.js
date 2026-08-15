import { getAreaOptions } from "../../controllers/locationOptions/locationOptions.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

const allowed = [roles.OWNER, roles.ADMIN];

export const registerLocationOptionsRoutes = (app) => {
  app.get("/api/settings/pricing/area-options", verifyToken, requireRole(allowed), getAreaOptions);
};