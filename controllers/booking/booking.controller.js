import { getAllBookings, updateBooking, markBookingDroppedOff, markDeviceChecked, settleDeposit, getReturnChecklist, approveCancellationRequest, rejectCancellationRequest } from "../../services/booking/booking.service.js";
import { deleteBookingWithCascade } from "../../services/booking/bookingDelete.service.js";

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

// ── Required GPS device-check note at Return — does not touch gpsDevice, see booking.service.js ──
export const deviceCheck = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body || {};
    const result = await markDeviceChecked(id, note, req.user?.email || req.user?.uid || null);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[BOOKINGS] deviceCheck error:", error);
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