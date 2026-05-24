import {
  getInventory,
  getNearestBooking,
  saveBefore,
  saveAfter,
} from "../../controllers/inventory/inventory.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerInventoryRoutes = (app) => {
  // Get before + after inventory records for a booking
  app.get("/api/inventory/booking/:bookingID", verifyToken, getInventory);

  // Get nearest upcoming booking for a car (used by frontend Inventory page)
  app.get("/api/inventory/nearest-booking/:carID", verifyToken, getNearestBooking);

  // Save Before Trip inspection
  // Triggers RULE 1 notification if damage parts found
  app.post("/api/inventory/before-trip", verifyToken, saveBefore);

  // Save After Trip inspection
  // Triggers RULE 2 notification per damaged/stolen part (charges customer)
  app.post("/api/inventory/after-trip", verifyToken, saveAfter);
};
