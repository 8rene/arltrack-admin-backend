import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import {
  getRegions,
  getProvinces,
  getMunicipalities,
  getBarangays,
} from "../../controllers/location/location.controller.js";

// Reference data only (PH regions/provinces/municipalities/barangays) —
// no role restriction beyond being logged in, since any role editing their
// own address on the Account page needs this. Same data source (Firestore
// regions/provinces/municipalities/barangays collections) the customer
// backend's /api/location/* already reads from.
export const registerLocationRoutes = (app) => {
  app.get("/api/location/regions", verifyToken, getRegions);
  app.get("/api/location/provinces", verifyToken, getProvinces);
  app.get("/api/location/municipalities", verifyToken, getMunicipalities);
  app.get("/api/location/barangays", verifyToken, getBarangays);
};