import {
  getAddresses,
  addAddress,
  editAddress,
  removeAddress,
} from "../../controllers/addresses/addresses.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View / add / edit: Owner, Admin, Supervisor. Delete: Owner, Admin only.
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];
const deleteAllowed = [roles.OWNER, roles.ADMIN];

// :level is one of regions | provinces | municipalities | barangays.
export const registerAddressesRoutes = (app) => {
  app.get   ("/api/addresses",            verifyToken, requireRole(allowed),       getAddresses);
  app.post  ("/api/addresses/:level",     verifyToken, requireRole(allowed),       addAddress);
  app.put   ("/api/addresses/:level/:id", verifyToken, requireRole(allowed),       editAddress);
  app.delete("/api/addresses/:level/:id", verifyToken, requireRole(deleteAllowed), removeAddress);
};
