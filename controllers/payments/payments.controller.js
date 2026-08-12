import {
  getAllPayments,
  updatePaymentStatus,
  getPaymentById,
  collectRemainingBalance,
  confirmInitialPayment,
  applyDiscount,
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

// Staff (Owner/Admin/Supervisor) applying a flat-peso discount to a
// booking — from Payments.jsx or Car Tracking. Deliberately not exposed
// to drivers: they see the resulting discounted balance (via
// resolvePaymentInfo/computeAmounts) but can't set the discount itself.
export const discountPayment = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const { amount, reason } = req.body;
    const appliedBy = req.user?.email || req.user?.uid || "staff";
    const result = await applyDiscount(bookingID, amount, reason, appliedBy);
    return res.status(200).json({ success: true, data: result, message: "Discount applied." });
  } catch (error) {
    console.error("[PAYMENTS] discount error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Staff (Owner/Admin/Supervisor) confirming cash/in-person receipt of a
// booking's initial payment — e.g. at the counter or at pickup — without
// having to leave Car Tracking for the Payments page. PayMongo payments
// never need this; the webhook already confirms those automatically.
// See driverDispatch controller's confirmPayment for the driver-facing
// equivalent of this.
export const confirmPayment = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const confirmedBy = req.user?.email || req.user?.uid || "staff";
    await confirmInitialPayment(bookingID, confirmedBy);
    return res.status(200).json({ success: true, message: "Payment marked as received." });
  } catch (error) {
    console.error("[PAYMENTS] confirm error:", error);
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