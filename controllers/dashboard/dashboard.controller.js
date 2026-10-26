import { getDashboardMetrics, getReturnAlerts, getScheduledRefunds } from "../../services/dashboard/dashboard.service.js";

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

export const dashboardReturnAlerts = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await getReturnAlerts() });
  } catch (error) {
    console.error("[DASHBOARD] Error fetching return alerts:", error);
    return res.status(500).json({ success: false, message: "Failed to load refund alerts." });
  }
};

export const dashboardScheduledRefunds = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await getScheduledRefunds() });
  } catch (error) {
    console.error("[DASHBOARD] Error fetching scheduled refunds:", error);
    return res.status(500).json({ success: false, message: "Failed to load scheduled refunds." });
  }
};