import {
  listCarPartTypes,
  listCarPartsByCar,
  createCarPart,
  updateCarPart,
  deleteCarPart,
} from "../../services/carParts/carParts.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

// GET /api/car-parts/types
export const getCarPartTypes = async (req, res) => {
  try {
    const data = await listCarPartTypes();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PARTS] getCarPartTypes error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/car-parts/car/:carID
export const getCarParts = async (req, res) => {
  try {
    const { carID } = req.params;
    if (!carID) return res.status(400).json({ success: false, message: "carID is required." });
    const data = await listCarPartsByCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PARTS] getCarParts error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/car-parts
// Body: { carID, carPartName, carPartTypeID, serialNumber }
export const addCarPart = async (req, res) => {
  try {
    const { carID, carPartName, carPartTypeID, serialNumber } = req.body;
    const data = await createCarPart({ carID, carPartName, carPartTypeID, serialNumber });

    createAuditLog({
      action: "create",
      description: `Added part "${data.carPartName}" to car ${carID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[CAR_PARTS] Failed to write audit log:", err));

    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PARTS] addCarPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// PUT /api/car-parts/:id
// Body: any of { carPartName, carPartTypeID, serialNumber, status, replacedType, markReplaced }
// markReplaced:true is the "mark as replaced" shortcut used by Maintenance.jsx
// (sets status: "Replaced" + replacedAt server-side).
export const editCarPart = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await updateCarPart(id, req.body || {});

    const description = req.body?.markReplaced
      ? `Marked part "${data.carPartName}" as replaced (was ${req.body.replacedType || "damaged"}).`
      : `Updated part "${data.carPartName}".`;

    createAuditLog({
      action: "update",
      description,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[CAR_PARTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PARTS] editCarPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// DELETE /api/car-parts/:id
export const removeCarPart = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await deleteCarPart(id);

    createAuditLog({
      action: "delete",
      description: `Removed part "${data.carPartName}" from car ${data.carID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[CAR_PARTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[CAR_PARTS] removeCarPart error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};