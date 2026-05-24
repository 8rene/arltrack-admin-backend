import {
  getAllPayments,
  updatePaymentStatus,
  getPaymentById,
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
