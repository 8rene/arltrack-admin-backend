import { getPricing, updatePricing, getStoreSettings, updateStoreSettings } from "../../controllers/systemSettings/systemSettings.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Matches /settings page access in pagePermissions.js: Owner + Admin only.
const allowed = [roles.OWNER, roles.ADMIN];

export const registerSystemSettingsRoutes = (app) => {
  app.get("/api/settings/pricing", verifyToken, requireRole(allowed), getPricing);
  app.put("/api/settings/pricing", verifyToken, requireRole(allowed), updatePricing);
  app.get("/api/settings/store",   verifyToken, requireRole(allowed), getStoreSettings);
  app.put("/api/settings/store",   verifyToken, requireRole(allowed), updateStoreSettings);
};