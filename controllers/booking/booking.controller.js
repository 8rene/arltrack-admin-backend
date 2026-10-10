import { getAllBookings, updateBooking, markBookingDroppedOff, settleDeposit, getReturnChecklist, approveCancellationRequest, rejectCancellationRequest } from "../../services/booking/booking.service.js";
import { deleteBookingWithCascade } from "../../services/booking/bookingDelete.service.js";
import { adminCancelBooking, getAdminBookingRefundPreview, markBookingNoShow } from "../../services/refundRequest/refundRequest.service.js";

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
    const { method, referenceNumber } = req.body || {};
    const result = await settleDeposit(id, { method, referenceNumber }, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] settleDeposit error:", error);
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

// ── DELETE (cascading archive → delete) ───────────────────────
export const deleteBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const archivedBy = req.user?.username || req.user?.uid || "admin";

    const result = await deleteBookingWithCascade(id, archivedBy);

    return res.status(200).json({
      success : true,
      message : result.message,
      data    : {
        bookingDocID        : result.bookingDocID,
        bookingID           : result.bookingID,
        bookingArchivesID   : result.bookingArchivesID,
        paymentsArchivesID  : result.paymentsArchivesID,
        reviewsArchivesIDs  : result.reviewsArchivesIDs,
        reviewsArchivedCount: result.reviewsArchivedCount,
      },
    });
  } catch (error) {
    console.error("[BOOKINGS] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ── Admin: refund + cancel (or cancel only) an upcoming / to-pay booking ──
// GET  /api/bookings/:id/refund-preview            → what a refund would return
// POST /api/bookings/:id/refund-cancel { reason, refund: true|false }
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
// Upcoming booking whose pickup time has passed: deposit kept, everything else refunded.
export const markNoShow = async (req, res) => {
  try {
    const { reason } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await markBookingNoShow(req.params.id, { reason }, adminUserID);
    const message = data.amount > 0
      ? `Marked as a no-show. The deposit was kept and ${Number(data.amount).toLocaleString()} was refunded${data.manualAmount > 0 ? " — part of it must be handed back in person (mark it returned on the Refund Requests page)" : ""}.`
      : "Marked as a no-show. The customer only paid the non-refundable deposit, so there is nothing to refund.";
    return res.status(200).json({ success: true, message, data });
  } catch (error) {
    console.error("[BOOKINGS] markNoShow error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

export const refundAndCancel = async (req, res) => {
  try {
    const { reason, refund } = req.body || {};
    const adminUserID = req.user?.userID || req.user?.uid || null;
    const data = await adminCancelBooking(req.params.id, { reason, refund: refund !== false }, adminUserID);
    const message = data.outcome === "cancelled_no_refund"
      ? "Booking cancelled. No refund was issued."
      : data.manualAmount > 0
        ? "Booking cancelled and refund sent to PayMongo. Part of it must be handed back in person — mark it as returned on the Refund Requests page."
        : data.amount > 0
          ? "Booking cancelled and refund sent to PayMongo. Final status updates once PayMongo confirms."
          : "Booking cancelled. Nothing had been paid, so there was nothing to refund.";
    return res.status(200).json({ success: true, message, data });
  } catch (error) {
    console.error("[BOOKINGS] refundAndCancel error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};