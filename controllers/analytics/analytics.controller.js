import {
  getDailyAnalytics,
  getWeeklyAnalytics,
  getMonthlyAnalytics,
  getYearlyAnalytics,
  getDailyBookingTrend,
  getWeeklyBookingTrend,
  getMonthlyBookingTrend,
} from "../../services/analytics/analytics.service.js";

// metric=revenue (default) -> $ trend from payments
// metric=bookings          -> count trend from bookings
// Booking trend currently only supports daily/weekly/monthly (matches
// the Analytics page's Booking Trend widget, which doesn't offer a
// yearly view).
export const analyticsData = async (req, res) => {
  try {
    const { type, metric = "revenue" } = req.query;

    let result;

    if (metric === "bookings") {
      if (type === "daily") {
        result = await getDailyBookingTrend();
      } else if (type === "weekly") {
        result = await getWeeklyBookingTrend();
      } else if (type === "monthly") {
        result = await getMonthlyBookingTrend();
      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid type for bookings metric. Use: daily, weekly, or monthly.",
        });
      }
    } else if (metric === "revenue") {
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
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid metric. Use: revenue or bookings.",
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