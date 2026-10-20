import {
  getAllPayments,
  updatePaymentStatus,
  getPaymentById,
  collectRemainingBalance,
  applyDiscount,
  notifyBalanceDue,
  markRefundIssued,
  retryDiscountRefund,
} from "../../services/payments/payments.service.js";
import { applyCreditToUnpaidPenalties } from "../../services/penalty/penalty.service.js";

// The acting staff member as a uid -- what paymentEntries.processedBy stores (same convention as the refund and
// penalty controllers). The email is only a fallback for tokens that carry no uid.
const actorUid = (req) => req.user?.userID || req.user?.uid || req.user?.email || null;

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
    await updatePaymentStatus(id, status, actorUid(req) || null);
    return res.status(200).json({ success: true, message: "Status updated." });
  } catch (error) {
    console.error("[PAYMENTS] patch error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Staff (Owner/Admin/Supervisor) giving a flat-peso discount to a
// booking (more than one can be given: each is its own ledger row) — from Payments.jsx or Car Tracking. Deliberately not exposed
// to drivers: they see the resulting discounted balance (via
// resolvePaymentInfo/computeAmounts) but can't set the discount itself.
export const discountPayment = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const { amount, reason } = req.body;
    const appliedBy = req.user?.email || req.user?.uid || "staff";
    const result = await applyDiscount(bookingID, amount, reason, appliedBy, actorUid(req));
    // A discount on a fully paid booking is held as credit. If a penalty is still unpaid, the credit pays it right away
    // (credit only, never the deposit). The discount is already saved, so this never fails the request.
    let paidPenalties = null;
    if (result.kind === "credit") {
      const r = await applyCreditToUnpaidPenalties(bookingID, actorUid(req));
      if (r.fromCredit > 0) {
        paidPenalties = r;
        result.creditHeld = Math.max(0, Math.round((result.creditHeld - r.fromCredit) * 100) / 100);
      }
    }
    return res.status(200).json({ success: true, data: { ...result, creditPaidPenalties: paidPenalties ? paidPenalties.fromCredit : 0 }, message: "Discount applied." });
  } catch (error) {
    // Every failure this function throws is an expected business-rule
    // rejection (exceeds total fee, no driver assigned yet, etc.), already
    // surfaced to the user via the response message — not a real bug.
    console.warn("[PAYMENTS] discount rejected:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Supervisor / Admin / Owner recording that a refund which could NOT go back through PayMongo
// (money received in store) was handed back in store. Needs how it was returned and, for
// anything but cash, the reference number.
export const refundIssued = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const { paymentMethod, referenceNumber } = req.body || {};
    const issuedBy = actorUid(req) || "staff";
    await markRefundIssued(bookingID, issuedBy, { paymentMethod, referenceNumber });
    return res.status(200).json({ success: true, message: "Refund marked as returned." });
  } catch (error) {
    console.error("[PAYMENTS] refund-issued error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Retry a discount refund that PayMongo accepted and then failed.
export const retryDiscountRefundPayment = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const data = await retryDiscountRefund(bookingID, actorUid(req) || "staff");
    return res.status(200).json({ success: true, data, message: "Refund sent to PayMongo again." });
  } catch (error) {
    console.warn("[PAYMENTS] discount-refund retry rejected:", error.message);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// IN-STORE payment of the remaining balance — Supervisor / Admin / Owner only (drivers no longer
// collect cash). The normal way to pay is online; this records the exception with its details:
// payment mode and reference number (required for anything but cash).
export const collectBalance = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const { paymentMethod, referenceNumber } = req.body || {};
    const collectedBy = actorUid(req) || "staff";
    await collectRemainingBalance(bookingID, collectedBy, paymentMethod, referenceNumber);
    return res.status(200).json({ success: true, message: "In-store payment recorded." });
  } catch (error) {
    console.error("[PAYMENTS] collect-balance error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// "Notify customer to pay" the remaining balance (bell notification, 6-hour cooldown per booking).
export const notifyBalance = async (req, res) => {
  try {
    const { bookingID } = req.params;
    const data = await notifyBalanceDue(bookingID, actorUid(req) || null);
    return res.status(200).json({ success: true, data, message: "Customer notified." });
  } catch (error) {
    if (error.status !== 429) console.warn("[PAYMENTS] notify-balance rejected:", error.message);
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.retryAfterSeconds != null ? { retryAfterSeconds: error.retryAfterSeconds, lastNotifiedAt: error.lastNotifiedAt } : {}),
    });
  }
};