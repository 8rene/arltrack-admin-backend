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
} from "../../services/fleet/fleet.service.js";

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
export const editCar = async (req, res) => {
  try {
    const { carID } = req.params;
    const data = await updateCar(carID, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[FLEET] editCar error:", error);
    const status = error.message === "Car not found." ? 404 : 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// PATCH /api/fleet/cars/:carID/status
// Body: { status: "Active" | "Rented" | "Reserved" | "Maintenance" | "Inactive" }
export const changeCarStatus = async (req, res) => {
  try {
    const { carID } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, message: "status is required." });
    const data = await updateCarStatus(carID, status);
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