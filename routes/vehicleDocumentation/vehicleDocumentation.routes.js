import {
  getVehicleDocs,
  saveBeforeTrip,
  saveAfterTrip,
} from "../../controllers/vehicleDocumentation/vehicleDocumentation.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerVehicleDocsRoutes = (app) => {
  // Get before + after vehicle documentation records for a booking
  app.get("/api/vehicle-docs/booking/:bookingID", verifyToken, getVehicleDocs);

  // Save (upsert) Before Trip documentation
  // Body: { bookingID, carID, photoFields: { frontViewUrl, sideViewUrl, backViewUrl, ...partFields } }
  app.post("/api/vehicle-docs/before-trip", verifyToken, saveBeforeTrip);

  // Save (upsert) After Trip documentation
  // Body: { bookingID, carID, photoFields: { frontViewUrl, sideViewUrl, backViewUrl, ...partFields } }
  app.post("/api/vehicle-docs/after-trip", verifyToken, saveAfterTrip);
};
