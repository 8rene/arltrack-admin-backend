import { generateReport } from "../../services/reports/reports.service.js";

export const getReport = async (req, res) => {
  try {
    const { period = "monthly", year, month, week, day } = req.query;
    const allowed = ["daily", "weekly", "monthly", "yearly"];
    if (!allowed.includes(period)) {
      return res.status(400).json({ success: false, message: "Invalid period. Use: daily, weekly, monthly, yearly." });
    }

    if (!year) {
      return res.status(400).json({ success: false, message: "Year is required." });
    }
    if (["monthly", "weekly", "daily"].includes(period) && !month) {
      return res.status(400).json({ success: false, message: "Month is required for this period." });
    }
    if (period === "weekly" && !week) {
      return res.status(400).json({ success: false, message: "Week is required for a weekly report." });
    }
    if (period === "daily" && !day) {
      return res.status(400).json({ success: false, message: "Day is required for a daily report." });
    }

    const data = await generateReport(period, { year, month, week, day });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[REPORTS] error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};