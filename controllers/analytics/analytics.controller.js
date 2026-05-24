import {
  getDailyAnalytics,
  getWeeklyAnalytics,
  getMonthlyAnalytics,
  getYearlyAnalytics,
} from "../../services/analytics/analytics.service.js";

export const analyticsData = async (req, res) => {
  try {
    const { type } = req.query;

    let result;

    if (type === "daily") {
      result = await getDailyAnalytics();
    } else if (type === "weekly") {
      result = await getWeeklyAnalytics();
    } else if (type === "monthly") {
      result = await getMonthlyAnalytics();
    } else if (type === "yearly") {
      result = await getYearlyAnalytics();
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid analytics type. Use: daily, weekly, monthly, or yearly.",
      });
    }

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[ANALYTICS] Error fetching analytics:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load analytics data. Please try again.",
    });
  }
};
