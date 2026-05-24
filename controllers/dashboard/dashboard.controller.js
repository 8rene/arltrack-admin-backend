import { getDashboardMetrics } from "../../services/dashboard/dashboard.service.js";

export const dashboardMetrics = async (req, res) => {
  try {
    const metrics = await getDashboardMetrics();
    return res.status(200).json({ success: true, data: metrics });
  } catch (error) {
    console.error("[DASHBOARD] Error fetching metrics:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load dashboard metrics. Please try again.",
    });
  }
};
