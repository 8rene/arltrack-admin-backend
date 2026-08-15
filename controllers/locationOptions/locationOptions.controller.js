import { searchAreaOptions } from "../../services/locationOptions/locationOptions.service.js";

// GET /api/settings/pricing/area-options?q=man
export const getAreaOptions = async (req, res) => {
  try {
    const data = await searchAreaOptions(req.query.q || "");
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[SETTINGS] getAreaOptions error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};