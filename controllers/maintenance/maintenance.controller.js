import {
  getMaintenanceConfig,
  getAllMaintenance,
  getMaintenanceById,
  getMaintenanceByCar,
  createMaintenance,
  updateMaintenance,
  updateMaintenanceStatus,
  deleteMaintenance,
} from "../../services/maintenance/maintenance.service.js";

// GET /api/maintenance/config
export const getConfig = async (req, res) => {
  try {
    const data = getMaintenanceConfig();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] getConfig error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/maintenance
export const listMaintenance = async (req, res) => {
  try {
    const data = await getAllMaintenance();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] listMaintenance error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/maintenance/:id
export const getOneMaintenance = async (req, res) => {
  try {
    const data = await getMaintenanceById(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] getOneMaintenance error:", error);
    return res.status(404).json({ success: false, message: error.message });
  }
};

// GET /api/maintenance/car/:carID
export const listMaintenanceByCar = async (req, res) => {
  try {
    const data = await getMaintenanceByCar(req.params.carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] listMaintenanceByCar error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/maintenance
export const addMaintenance = async (req, res) => {
  try {
    const data = await createMaintenance(req.body);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] addMaintenance error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// PUT /api/maintenance/:id
export const editMaintenance = async (req, res) => {
  try {
    const data = await updateMaintenance(req.params.id, req.body);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] editMaintenance error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// PATCH /api/maintenance/:id/status
export const setMaintenanceStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const data = await updateMaintenanceStatus(req.params.id, status);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] setMaintenanceStatus error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// DELETE /api/maintenance/:id
export const removeMaintenance = async (req, res) => {
  try {
    const data = await deleteMaintenance(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[MAINTENANCE] removeMaintenance error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};