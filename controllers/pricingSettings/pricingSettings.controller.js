import {
  getPricingSettings,
  updatePricingSettings,
} from "../../services/pricingSettings/pricingSettings.service.js";

// GET /api/settings/pricing
export const getPricing = async (req, res) => {
  try {
    const data = await getPricingSettings();
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
    const data = await updatePricingSettings(req.body || {}, actor);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SETTINGS] updatePricing error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};