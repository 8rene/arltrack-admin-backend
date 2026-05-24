import { generateReport } from "../../services/reports/reports.service.js";

export const getReport = async (req, res) => {
  try {
    const { period = "monthly" } = req.query;
    const allowed = ["daily", "weekly", "monthly", "yearly"];
    if (!allowed.includes(period)) {
      return res.status(400).json({ success: false, message: "Invalid period. Use: daily, weekly, monthly, yearly." });
    }
    const data = await generateReport(period);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REPORTS] error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
