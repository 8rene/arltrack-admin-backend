import { listEntries } from "../../services/paymentEntries/paymentEntries.service.js";

// GET /api/payment-entries?paymentID=… | penaltyID=… | refundRequestID=… | bookingID=…   (exactly one)
// Works for live, archived and orphaned records alike -- it reads the money rows, not the parent document.
export const getPaymentEntries = async (req, res) => {
  try {
    const keys = ["paymentID", "penaltyID", "refundRequestID", "bookingID"].filter((k) => req.query[k]);
    if (keys.length !== 1) {
      return res.status(400).json({ success: false, message: "Pass exactly one of paymentID, penaltyID, refundRequestID or bookingID." });
    }
    const data = await listEntries({ [keys[0]]: String(req.query[keys[0]]) });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PAYMENT ENTRIES] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};