import {
  getAllPayments,
  updatePaymentStatus,
  getPaymentById,
  collectRemainingBalance,
} from "../../services/payments/payments.service.js";

export const listPayments = async (req, res) => {
  try {
    const data = await getAllPayments();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PAYMENTS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await getPaymentById(id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PAYMENTS] get error:", error);
    return res.status(404).json({ success: false, message: error.message });
  }
};

export const patchPaymentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await updatePaymentStatus(id, status);
    return res.status(200).json({ success: true, message: "Status updated." });
  } catch (error) {
    console.error("[PAYMENTS] patch error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Staff (Owner/Admin/Supervisor) receiving cash/in-person payment of the
// remaining balance — e.g. before or during pickup. See driverDispatch
// controller's collectBalance for the driver-facing equivalent of this.
export const collectBalance = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const collectedBy = req.user?.email || req.user?.uid || "staff";
    await collectRemainingBalance(bookingID, collectedBy);
    return res.status(200).json({ success: true, message: "Balance marked as collected." });
  } catch (error) {
    console.error("[PAYMENTS] collect-balance error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};