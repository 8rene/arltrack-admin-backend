import {
  getCarPartTypes,
  getCarParts,
  addCarPart,
  editCarPart,
  removeCarPart,
} from "../../controllers/carParts/carParts.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Matches the access already declared for Inventory (routes/inventory) and
// Maintenance (routes/maintenance) — Owner, Supervisor, Admin.
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerCarPartsRoutes = (app) => {
  app.get   ("/api/car-parts/types",     verifyToken, requireRole(allowed), getCarPartTypes);
  app.get   ("/api/car-parts/car/:carID", verifyToken, requireRole(allowed), getCarParts);
  app.post  ("/api/car-parts",           verifyToken, requireRole(allowed), addCarPart);
  app.put   ("/api/car-parts/:id",       verifyToken, requireRole(allowed), editCarPart);
  app.delete("/api/car-parts/:id",       verifyToken, requireRole(allowed), removeCarPart);
};