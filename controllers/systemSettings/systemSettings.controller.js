import {
  getSystemSettings,
  updateSystemSettings,
} from "../../services/systemSettings/systemSettings.service.js";

// GET /api/settings/pricing
export const getPricing = async (req, res) => {
  try {
    const data = await getSystemSettings();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SETTINGS] getPricing error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/settings/pricing
// Body: any subset of { serviceFee, gatewayFee, depositFee, extraFeeOutsideArea,
//   driversFeeBaseArea, driversFeeOutsideArea, baseAreaKeywords, billingBlockHours }
export const updatePricing = async (req, res) => {
  try {
    const actor = req.user ? { userID: req.user.uid, name: req.user.email } : null;
    const data = await updateSystemSettings(req.body || {}, actor);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SETTINGS] updatePricing error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/settings/store
// Same underlying systemSettings doc as pricing — this just reads/writes
// through the storeName/storeLat/storeLng slice of it. Separate named
// endpoint since "Store Location & Name" is its own section on Settings.jsx.
export const getStoreSettings = async (req, res) => {
  try {
    const { storeName, storeLat, storeLng } = await getSystemSettings();
    return res.status(200).json({ success: true, data: { storeName, storeLat, storeLng } });
  } catch (error) {
    console.error("[SETTINGS] getStoreSettings error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/settings/store
// Body: { storeName, storeLat, storeLng } — or all blank/null to clear
// (turns off "Pick up in-store" on the customer app).
export const updateStoreSettings = async (req, res) => {
  try {
    const actor = req.user ? { userID: req.user.uid, name: req.user.email } : null;
    const { storeName, storeLat, storeLng } = await updateSystemSettings(req.body || {}, actor);
    return res.status(200).json({ success: true, data: { storeName, storeLat, storeLng } });
  } catch (error) {
    console.error("[SETTINGS] updateStoreSettings error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};