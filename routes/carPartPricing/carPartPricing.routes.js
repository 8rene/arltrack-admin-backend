import {
  getPricingForCar,
  getPricingForPart,
  setPricingForPart,
  removePricingForPart,
} from "../../controllers/carPartPricing/carPartPricing.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Same access as car parts themselves (routes/carParts) — Owner, Supervisor, Admin.
const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerCarPartPricingRoutes = (app) => {
  app.get   ("/api/car-part-pricing/car/:carID",       verifyToken, requireRole(allowed), getPricingForCar);
  app.get   ("/api/car-part-pricing/part/:carPartID",  verifyToken, requireRole(allowed), getPricingForPart);
  app.put   ("/api/car-part-pricing/part/:carPartID",  verifyToken, requireRole(allowed), setPricingForPart);
  app.delete("/api/car-part-pricing/part/:carPartID",  verifyToken, requireRole(allowed), removePricingForPart);
};