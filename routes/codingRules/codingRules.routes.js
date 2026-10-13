import {
  getCodingRules,
  addCodingRule,
  addCodingCity,
  editCodingRule,
  removeCodingRule,
  removeCodingCity,
} from "../../controllers/codingRules/codingRules.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View / add / edit: Owner, Admin, Supervisor. Delete: Owner, Admin only.
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];
const deleteAllowed = [roles.OWNER, roles.ADMIN];

export const registerCodingRulesRoutes = (app) => {
  app.get   ("/api/coding-rules",      verifyToken, requireRole(allowed),       getCodingRules);
  app.post  ("/api/coding-rules",      verifyToken, requireRole(allowed),       addCodingRule);
  // "city" is registered before "/:id" so it is never captured as an id.
  app.post  ("/api/coding-rules/city", verifyToken, requireRole(allowed),       addCodingCity);
  app.put   ("/api/coding-rules/:id",  verifyToken, requireRole(allowed),       editCodingRule);
  // Whole city (all its rules). Two path segments, so it never collides with "/:id".
  app.delete("/api/coding-rules/city/:city", verifyToken, requireRole(deleteAllowed), removeCodingCity);
  app.delete("/api/coding-rules/:id",  verifyToken, requireRole(deleteAllowed), removeCodingRule);
};