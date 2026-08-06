import {
  getCars,
  getCar,
  createCar,
  editCar,
  changeCarStatus,
  removeCar,
  getCarPricing,
  addCarPricing,
  editCarPricing,
  removeCarPricing,
  replaceCarPricing,
  getBrands,
  createBrand,
  removeBrand,
  getModels,
  createModel,
  removeModel,
} from "../../controllers/fleet/fleet.controller.js";
import { verifyToken }            from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles }     from "../../middlewares/role/role.middleware.js";

const allowed = [roles.OWNER, roles.SUPERVISOR, roles.ADMIN];

export const registerFleetRoutes = (app) => {
  // ── Cars ──────────────────────────────────────────
  app.get   ("/api/fleet/cars",                          verifyToken, requireRole(allowed), getCars);
  app.get   ("/api/fleet/cars/:carID",                   verifyToken, requireRole(allowed), getCar);
  app.post  ("/api/fleet/cars",                          verifyToken, requireRole(allowed), createCar);
  app.put   ("/api/fleet/cars/:carID",                   verifyToken, requireRole(allowed), editCar);
  app.patch ("/api/fleet/cars/:carID/status",            verifyToken, requireRole(allowed), changeCarStatus);
  app.delete("/api/fleet/cars/:carID",                   verifyToken, requireRole(allowed), removeCar);

  // ── Pricing ───────────────────────────────────────
  app.get   ("/api/fleet/cars/:carID/pricing",           verifyToken, requireRole(allowed), getCarPricing);
  app.post  ("/api/fleet/cars/:carID/pricing",           verifyToken, requireRole(allowed), addCarPricing);
  app.put   ("/api/fleet/cars/:carID/pricing/replace",   verifyToken, requireRole(allowed), replaceCarPricing);
  app.put   ("/api/fleet/pricing/:pricingID",            verifyToken, requireRole(allowed), editCarPricing);
  app.delete("/api/fleet/pricing/:pricingID",            verifyToken, requireRole(allowed), removeCarPricing);

  // ── Brands ────────────────────────────────────────
  app.get   ("/api/fleet/brands",                        verifyToken, requireRole(allowed), getBrands);
  app.post  ("/api/fleet/brands",                        verifyToken, requireRole(allowed), createBrand);
  app.delete("/api/fleet/brands/:brandID",               verifyToken, requireRole(allowed), removeBrand);

  // ── Models ────────────────────────────────────────
  app.get   ("/api/fleet/models",                        verifyToken, requireRole(allowed), getModels);
  app.post  ("/api/fleet/models",                        verifyToken, requireRole(allowed), createModel);
  app.delete("/api/fleet/models/:modelID",               verifyToken, requireRole(allowed), removeModel);
};
