import {
  listPricingByCar,
  getPricingByPartID,
  upsertPricing,
  deletePricingByPartID,
} from "../../services/carPartPricing/carPartPricing.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

// GET /api/car-part-pricing/car/:carID
// Every part of the car with its price (price: null if not priced yet).
export const getPricingForCar = async (req, res) => {
  try {
    const { carID } = req.params;
    if (!carID) return res.status(400).json({ success: false, message: "carID is required." });
    const data = await listPricingByCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PART_PRICING] getPricingForCar error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// GET /api/car-part-pricing/part/:carPartID
export const getPricingForPart = async (req, res) => {
  try {
    const { carPartID } = req.params;
    const data = await getPricingByPartID(carPartID);
    if (!data) return res.status(404).json({ success: false, message: "No pricing set for this part." });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PART_PRICING] getPricingForPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// PUT /api/car-part-pricing/part/:carPartID
// Body: { price }  — creates the pricing if none exists, otherwise updates it.
export const setPricingForPart = async (req, res) => {
  try {
    const { carPartID } = req.params;
    const data = await upsertPricing(carPartID, req.body?.price);

    createAuditLog({
      action: data.created ? "create" : "update",
      description: `${data.created ? "Set" : "Updated"} price of part "${data.carPartName}" to ₱${data.price}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[CAR_PART_PRICING] Failed to write audit log:", err));

    return res.status(data.created ? 201 : 200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PART_PRICING] setPricingForPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// DELETE /api/car-part-pricing/part/:carPartID
export const removePricingForPart = async (req, res) => {
  try {
    const { carPartID } = req.params;
    const deleted = await deletePricingByPartID(carPartID);
    if (!deleted) return res.status(404).json({ success: false, message: "No pricing set for this part." });

    createAuditLog({
      action: "delete",
      description: `Removed price for part ${carPartID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[CAR_PART_PRICING] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: { carPartID } });
  } catch (error) {
    console.error("[CAR_PART_PRICING] removePricingForPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};