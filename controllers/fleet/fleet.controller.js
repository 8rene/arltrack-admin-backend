import {
  getAllCars,
  getCarById,
  addCar,
  updateCar,
  updateCarStatus,
  deleteCar,
  getPricingByCar,
  addPricingTier,
  updatePricingTier,
  deletePricingTier,
  replacePricingForCar,
  getAllBrands,
  addBrand,
  deleteBrand,
  getAllModels,
  addModel,
  deleteModel,
  setPrimaryCarImage,
  getOpenBookingsForCar,
  getCarBookingsForStatusChange,
} from "../../services/fleet/fleet.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { consumeOtp } from "../otp/otp.controller.js";

// Statuses that need a reason + OTP + a clean bookings check before they can
// be written — see changeCarStatus() below. Leaving Maintenance/Inactive
// (going back to Active) never needs any of this.
const GATED_STATUSES = ["Maintenance", "Inactive"];

// ─────────────────────────────────────────────
// CARS
// ─────────────────────────────────────────────

// GET /api/fleet/cars
export const getCars = async (req, res) => {
  try {
    const data = await getAllCars();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getCars error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/fleet/cars/:carID
export const getCar = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await getCarById(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getCar error:", error);
    const status = error.message === "Car not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// POST /api/fleet/cars
// Body: { brandID, modelID, platenumber, color, bodyType, year, seatingCapacity,
//         fuelType, transmission, status, shortDescription, longDescription,
//         pricing: [{ durationType, price }] }
export const createCar = async (req, res) => {
  try {
    const data = await addCar(req.body);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] createCar error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// PUT /api/fleet/cars/:carID
// Body: any subset of car fields (excluding pricing — use /pricing endpoints)
//
// Deliberately refuses to move status into Maintenance/Inactive from here —
// the EditCarModal's Details tab used to send status as just another field
// in this same call, which meant it could switch a car out of service with
// no reason, no bookings check, and no OTP. That whole flow now runs first
// against the dedicated /status endpoint below (reason → refund-any-upcoming
// bookings → OTP), and only THEN does the rest of the edit form save through
// here — with status either unchanged or already applied, either way fine.
export const editCar = async (req, res) => {
  try {
    const { carID } = req.params;
    if (GATED_STATUSES.includes(req.body?.status)) {
      const carDoc = await getCarById(carID).catch(() => null);
      if (carDoc && carDoc.status !== req.body.status) {
        return res.status(400).json({
          success: false,
          message: `Switching a car to ${req.body.status} needs a reason and confirmation — use the status control instead of Save Changes.`,
        });
      }
    }
    const data = await updateCar(carID, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] editCar error:", error);
    const status = error.message === "Car not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// GET /api/fleet/cars/:carID/status-change-preview
// What staff see before confirming a switch to Maintenance/Inactive: every
// upcoming booking on this car (with what refunding it would cost) and
// every ongoing one (FYI only — the car's already with that customer, so
// there's nothing to refund or cancel here).
export const getStatusChangePreview = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await getCarBookingsForStatusChange(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getStatusChangePreview error:", error);
    const status = error.message === "Car not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// PATCH /api/fleet/cars/:carID/status
// Body: { status, statusReason?, otp? }
//
// Moving TO Maintenance or Inactive is gated three ways: a reason is
// required, the acting staff member must supply a fresh OTP sent to their
// OWN email (consumeOtp — same "prove it's really you" mechanic already
// used for role changes), and every upcoming booking on the car must
// already be refunded/cancelled (re-checked here server-side, never just
// trusted from the frontend, which is why Fleet.jsx's own gate could never
// be enough on its own). Moving to any other status (back to Active) skips
// all three — there's no bookings-safety concern leaving service.
export const changeCarStatus = async (req, res) => {
  try {
    const { carID } = req.params;
    const { status, statusReason, otp } = req.body;
    if (!status) return res.status(400).json({ success: false, message: "status is required." });

    if (GATED_STATUSES.includes(status)) {
      if (!statusReason || !statusReason.trim()) {
        return res.status(400).json({ success: false, message: "A reason is required." });
      }
      if (!otp) {
        return res.status(400).json({ success: false, message: "Verification code is required." });
      }
      const otpResult = await consumeOtp(req.user?.email, otp);
      if (!otpResult.ok) {
        return res.status(otpResult.status).json({ success: false, message: otpResult.message });
      }

      const { upcoming } = await getOpenBookingsForCar(carID);
      if (upcoming.length > 0) {
        return res.status(409).json({
          success: false,
          message: `${upcoming.length} upcoming booking(s) still need to be refunded before this car can be marked ${status}.`,
        });
      }
    }

    const data = await updateCarStatus(carID, status, GATED_STATUSES.includes(status) ? statusReason.trim() : null);

    createAuditLog({
      action: "update",
      description: `Status changed for car ${carID} to ${status}${statusReason ? `: ${statusReason}` : "."}${GATED_STATUSES.includes(status) ? " (OTP-confirmed)" : ""}`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[FLEET] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] changeCarStatus error:", error);
    const status = error.message === "Car not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// DELETE /api/fleet/cars/:carID
export const removeCar = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await deleteCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] removeCar error:", error);
    const status = error.message === "Car not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// PRICING
// ─────────────────────────────────────────────

// GET /api/fleet/cars/:carID/pricing
export const getCarPricing = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await getPricingByCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getCarPricing error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/fleet/cars/:carID/pricing
// Body: { durationType, price }
export const addCarPricing = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await addPricingTier(carID, req.body);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] addCarPricing error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// PUT /api/fleet/pricing/:pricingID
// Body: { durationType, price }
export const editCarPricing = async (req, res) => {
  try {
    const { pricingID } = req.params;
    const data = await updatePricingTier(pricingID, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] editCarPricing error:", error);
    const status = error.message === "Pricing tier not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// DELETE /api/fleet/pricing/:pricingID
export const removeCarPricing = async (req, res) => {
  try {
    const { pricingID } = req.params;
    const data = await deletePricingTier(pricingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] removeCarPricing error:", error);
    const status = error.message === "Pricing tier not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// PUT /api/fleet/cars/:carID/pricing/replace
// Body: { pricing: [{ durationType, price }] }
// Replaces ALL pricing tiers for the car at once (bulk save from modal)
export const replaceCarPricing = async (req, res) => {
  try {
    const { carID } = req.params;
    const { pricing } = req.body;
    if (!Array.isArray(pricing)) {
      return res.status(400).json({ success: false, message: "pricing must be an array." });
    }
    const data = await replacePricingForCar(carID, pricing);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] replaceCarPricing error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// BRANDS
// ─────────────────────────────────────────────

// GET /api/fleet/brands
export const getBrands = async (req, res) => {
  try {
    const data = await getAllBrands();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getBrands error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/fleet/brands
// Body: { brandName }
export const createBrand = async (req, res) => {
  try {
    const { brandName } = req.body;
    const data = await addBrand(brandName);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] createBrand error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/fleet/brands/:brandID
export const removeBrand = async (req, res) => {
  try {
    const { brandID } = req.params;
    const data = await deleteBrand(brandID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] removeBrand error:", error);
    const status = error.message === "Brand not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// MODELS
// ─────────────────────────────────────────────

// GET /api/fleet/models?brandID=xxx  (optional filter)
export const getModels = async (req, res) => {
  try {
    const { brandID } = req.query;
    const data = await getAllModels(brandID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] getModels error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/fleet/models
// Body: { modelName, brandID }
export const createModel = async (req, res) => {
  try {
    const { modelName, brandID } = req.body;
    const data = await addModel(modelName, brandID);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] createModel error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/fleet/models/:modelID
export const removeModel = async (req, res) => {
  try {
    const { modelID } = req.params;
    const data = await deleteModel(modelID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] removeModel error:", error);
    const status = error.message === "Model not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// IMAGES
// ─────────────────────────────────────────────

// POST /api/fleet/cars/:carID/image
// Body: { imageURL } — the frontend uploads the file to Firebase Storage
// itself (client SDK) and sends the resulting downloadURL here; this
// endpoint only handles the Firestore carImages doc write, which used to
// happen directly from the browser with no role check or audit trail.
export const setCarImage = async (req, res) => {
  try {
    const { carID } = req.params;
    const { imageURL } = req.body;
    const data = await setPrimaryCarImage(carID, imageURL);

    createAuditLog({
      action: "update",
      description: `Updated primary image for car ${carID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[FLEET] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] setCarImage error:", error);
    const status = error.message === "Car not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};