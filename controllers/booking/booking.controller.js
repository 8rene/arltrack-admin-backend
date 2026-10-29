import { retryDepositReturn, handBackDepositReturn } from "../../services/depositReturn/depositReturn.service.js";
import { getAllBookings, updateBooking, markBookingDroppedOff, settleDeposit, getReturnChecklist, approveCancellationRequest, rejectCancellationRequest } from "../../services/booking/booking.service.js";
import { deleteHandler, previewDeleteHandler } from "./bookingDelete.controller.js";
import { adminCancelBooking, getAdminBookingRefundPreview, markBookingNoShow, getRefundAfterCancelPreview, refundCancelledBooking } from "../../services/refundRequest/refundRequest.service.js";

export const listBookings = async (req, res) => {
  try {
    const { status } = req.query;
    const data = await getAllBookings(status);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKINGS] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const editBooking = async (req, res) => {
  try {
    const { id } = req.params;
    await updateBooking(id, req.body, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[BOOKINGS] edit error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Cancellation request review (ongoing bookings only) ──
export const approveCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await approveCancellationRequest(id, req.user?.userID || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] approveCancellation error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const rejectCancellation = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await rejectCancellationRequest(id, reason, req.user?.userID || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] rejectCancellation error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Mark the vehicle physically dropped off, every booking type, separate from Return ──
export const markDroppedOff = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await markBookingDroppedOff(id, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] markDroppedOff error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Settle the security deposit at drop-off (deduct penalties, confirm handback) ──
export const settleDepositHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const { method, referenceNumber, online, completeBooking } = req.body || {};
    const result = await settleDeposit(id, { method, referenceNumber, online, completeBooking: completeBooking === true }, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] settleDeposit error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Online deposit return that PayMongo refused: retry it, or record that it was handed back in store ──
export const retryDepositReturnHandler = async (req, res) => {
  try {
    const data = await retryDepositReturn(req.params.id, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, message: "Deposit return sent to PayMongo again.", data });
  } catch (error) {
    console.error("[BOOKINGS] retryDepositReturn error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
export const handBackDepositReturnHandler = async (req, res) => {
  try {
    const { method, referenceNumber } = req.body || {};
    const data = await handBackDepositReturn(req.params.id, { method, referenceNumber }, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, message: "Deposit hand-back recorded.", data });
  } catch (error) {
    console.error("[BOOKINGS] handBackDepositReturn error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Read-only "what's still missing before Return" panel — never blocks anything ──
export const returnChecklist = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await getReturnChecklist(id);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] returnChecklist error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── DELETE (archives the booking with everything linked to it) ───────────
// The one delete in the system: see bookingDelete.controller.js (preview + guard + force).
export const deleteBooking = deleteHandler;
export const deleteBookingPreview = previewDeleteHandler;

// ── Admin: refund + cancel (or cancel only) an upcoming / to-pay booking ──
// GET  /api/bookings/:id/refund-preview            → what a refund would return
// POST /api/bookings/:id/refund-cancel { reason, refund: true|false, refundType: "full"|"normal" }
export const refundPreview = async (req, res) => {
  try {
    const data = await getAdminBookingRefundPreview(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKINGS] refundPreview error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// POST /api/bookings/:id/no-show { reason? }
// "No Deposit Refund" on an upcoming booking (before or after pickup): deposit kept, everything else refunded.
export const markNoShow = async (req, res) => {
  try {
    const { reason } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await markBookingNoShow(req.params.id, { reason }, adminUserID);
    const followUp = followUpOf(data);
    const message = followUp
      ? followUpMessage(followUp, "Cancelled with No Deposit Refund. The deposit was kept.", data)
      : data.amount > 0
        ? (data.scheduled
          ? `Cancelled with No Deposit Refund. The deposit was kept. The payment was made today, so ${pesoText(data.amount)} will be sent through PayMongo ${sendDayText(data.sendAfter)}.`
          : `Cancelled with No Deposit Refund. The deposit was kept and ${pesoText(data.amount)} is going back through PayMongo.`)
        : "Cancelled with No Deposit Refund. The customer only paid the non-refundable deposit, so there is nothing to refund.";
    return res.status(200).json({ success: true, message, data: { ...data, followUp } });
  } catch (error) {
    console.error("[BOOKINGS] markNoShow error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

// After a refund & cancel, what staff still have to follow up on. Three kinds of money can be involved:
//   online         goes back through PayMongo automatically
//   in store       can't go through PayMongo (collected in person, or paid by QR Ph): settle it in store
//   unrefundable   paid online but no PayMongo payment ID on record: refund it from the PayMongo dashboard
// null when everything went back online, so the screen has nothing extra to show.
const pesoText = (n) => `\u20B1${(Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const followUpOf = (data) => {
  const inStore = Number(data?.manualAmount) || 0;
  const unrefundable = Number(data?.unrefundableAmount) || 0;
  if (!(inStore > 0 || unrefundable > 0)) return null;
  const online = data.onlineAmount !== undefined && data.onlineAmount !== null
    ? Number(data.onlineAmount) || 0
    : Math.max(0, (Number(data.amount) || 0) - inStore);
  return { onlineAmount: online, inStoreAmount: inStore, unrefundableAmount: unrefundable, paymentID: data.paymentID || null, refundRequestID: data.refundRequestID || null };
};
// "after midnight" / "on <date>": a same-day payment's partial refund is sent by the cron after the next Manila midnight.
const sendDayText = (sendAfter) => {
  const d = sendAfter?.toDate ? sendAfter.toDate() : sendAfter?._seconds !== undefined ? new Date(sendAfter._seconds * 1000) : sendAfter ? new Date(sendAfter) : null;
  return d && !isNaN(d.getTime())
    ? `on ${d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "long", day: "numeric", year: "numeric" })} (after midnight)`
    : "after midnight";
};
const followUpMessage = (f, lead, data = null) => {
  const parts = [lead];
  const scheduled = !!(data && data.scheduled);
  if (f.inStoreAmount > 0) {
    parts.push(f.onlineAmount > 0
      ? (scheduled
        ? `The payment was made today, so ${pesoText(f.onlineAmount)} will be sent through PayMongo ${sendDayText(data.sendAfter)}. The other ${pesoText(f.inStoreAmount)} can't be refunded online, so please settle it in store.`
        : `Partial refund sent: ${pesoText(f.onlineAmount)} is going back through PayMongo. The other ${pesoText(f.inStoreAmount)} can't be refunded online, so please settle it in store.`)
      : `Nothing was sent to PayMongo. ${pesoText(f.inStoreAmount)} can't be refunded online, so please settle it in store.`);
  } else if (f.onlineAmount > 0) {
    parts.push(scheduled
      ? `The payment was made today, so ${pesoText(f.onlineAmount)} will be sent through PayMongo ${sendDayText(data.sendAfter)}.`
      : `${pesoText(f.onlineAmount)} is going back through PayMongo.`);
  }
  if (f.unrefundableAmount > 0) parts.push(`${pesoText(f.unrefundableAmount)} was paid online but has no PayMongo payment ID on record, so refund it from the PayMongo dashboard.`);
  return parts.join(" ");
};

export const refundAndCancel = async (req, res) => {
  try {
    const { reason, refund, refundType } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await adminCancelBooking(req.params.id, { reason, refund: refund !== false, refundType }, adminUserID);
    const followUp = data.outcome === "cancelled_no_refund" ? null : followUpOf(data);
    const feeNote = data.gatewayFeeKept > 0 ? ` The ${pesoText(data.gatewayFeeKept)} online payment fee was kept.` : "";
    const message = data.outcome === "cancelled_no_refund"
      ? "Booking cancelled. No refund was issued."
      : followUp
        ? followUpMessage(followUp, `Booking cancelled.${feeNote}`, data)
        : data.amount > 0
          ? (data.scheduled
            ? `Booking cancelled.${feeNote} The payment was made today, so ${pesoText(data.amount)} will be sent through PayMongo ${sendDayText(data.sendAfter)}.`
            : `Booking cancelled and refund sent to PayMongo.${feeNote} Final status updates once PayMongo confirms.`)
          : "Booking cancelled. Nothing had been paid, so there was nothing to refund.";
    return res.status(200).json({ success: true, message, data: { ...data, followUp } });
  } catch (error) {
    console.error("[BOOKINGS] refundAndCancel error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

// GET /api/bookings/:id/refund-after-cancel-preview
// A booking that was cancelled WITHOUT a refund: can money still go back, and what each option would return.
export const refundAfterCancelPreview = async (req, res) => {
  try {
    const data = await getRefundAfterCancelPreview(req.params.id);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKINGS] refundAfterCancelPreview error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// POST /api/bookings/:id/refund-after-cancel { option: "full"|"normal"|"no_show"|"manual", amount (manual only), reason }
// Records a refund for an already-cancelled booking. It is handed back in store; nothing is sent to PayMongo.
export const refundAfterCancel = async (req, res) => {
  try {
    const { option, amount, reason } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await refundCancelledBooking(req.params.id, { option, amount, reason }, adminUserID);
    return res.status(200).json({
      success: true,
      message: `Refund of ${pesoText(data.amount)} recorded. Hand it back in store, then mark it as handed back on the Refund Requests page.`,
      data,
    });
  } catch (error) {
    console.error("[BOOKINGS] refundAfterCancel error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};