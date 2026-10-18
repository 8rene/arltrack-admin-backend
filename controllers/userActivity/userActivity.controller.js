import { getCustomerActivity } from "../../services/userActivity/userActivity.service.js";

// GET /api/users/:uid/activity — a customer's recent activity feed (Users > Customers > Activity tab).
export const getActivity = async (req, res) => {
  try {
    const data = await getCustomerActivity(req.params.uid);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[USER ACTIVITY] error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};