import {
  getPublicTerms,
  getCurrent,
  listVersions,
  getVersion,
  createVersion,
} from "../../controllers/terms/terms.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Anyone logged in (any staff role) can READ the Terms; only Owner + Admin can edit.
const canRead = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR, roles.DRIVER];
const canEdit = [roles.OWNER, roles.ADMIN];

export const registerTermsRoutes = (app) => {
  // Public — signup page / T&C modal (no token)
  app.get("/api/terms/current", getPublicTerms);

  // Read — every staff role (Terms page)
  app.get("/api/settings/terms",               verifyToken, requireRole(canRead), getCurrent);
  app.get("/api/settings/terms/versions",      verifyToken, requireRole(canRead), listVersions);
  app.get("/api/settings/terms/versions/:id",  verifyToken, requireRole(canRead), getVersion);

  // Write — Owner + Admin only
  app.post("/api/settings/terms",              verifyToken, requireRole(canEdit), createVersion);
};