import {
  getAllBookingArchives,
  restoreBookingArchive,
  deleteBookingArchive,
  getInspectionRecordsForBooking,
} from "../../services/archives/bookingArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import { findLinkedBookingSessionArchive } from "../../services/archives/bookingSessionArchives.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// Resolves a bookingArchives row's own bookingID, given only its archive
// doc ID — every "View X" lookup below needs this first.
const resolveBookingID = async (bookingArchivesId) => {
  const doc = await db.collection("bookingArchives").doc(bookingArchivesId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  return data.bookingID ?? data.originalId ?? null;
};

export const listBookingArchives = async (req, res) => {
  try {
    const data = await getAllBookingArchives();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] list error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const restoreBookingArchiveHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const restoredBy = req.user?.username || req.user?.uid || "admin";
    const result = await restoreBookingArchive(bookingArchivesId, restoredBy);
    createAuditLog({
      action: "update",
      description: `Restored archived booking ${bookingArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[BOOKING ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: `Booking restored successfully.${result.restoredPayment ? " Payment also restored." : ""}${result.restoredReviews > 0 ? ` ${result.restoredReviews} review(s) also restored.` : ""}`,
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] restore error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteBookingArchiveHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const result = await deleteBookingArchive(bookingArchivesId);
    createAuditLog({
      action: "delete",
      description: `Permanently deleted archived booking ${bookingArchivesId}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[BOOKING ARCHIVE] Failed to write audit log:", err));
    return res.status(200).json({
      success: true,
      message: `Archived booking permanently deleted.${result.deletedPaymentArchive ? " Linked payment archive also deleted." : ""}${result.deletedReviewArchives > 0 ? ` ${result.deletedReviewArchives} review archive(s) also deleted.` : ""}${result.deletedSessionArchive ? " Linked booking session archive also deleted." : ""}${result.deletedInspectionDocs > 0 ? ` ${result.deletedInspectionDocs} vehicle inspection record(s) also deleted.` : ""}`,
      data: result,
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] delete error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/archives/bookings/:bookingArchivesId/payment
 * Feeds the "View Payment" modal on the Booking Archive page — just the
 * linked paymentsArchives record, scoped to this one booking. Stays a
 * modal, not a navigation, so archived data never surfaces outside the
 * Archive section.
 */
export const getLinkedPaymentArchiveHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const bookingID = await resolveBookingID(bookingArchivesId);
    if (!bookingID) {
      return res.status(404).json({ success: false, message: "Archived booking not found." });
    }

    const snap = await db
      .collection("paymentsArchives")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(200).json({ success: true, data: null, message: "No linked payment archive found for this booking." });
    }

    const data = snap.docs[0].data();
    return res.status(200).json({
      success: true,
      data: {
        paymentsArchivesId: snap.docs[0].id,
        ...data,
        createdAt:  toISO(data.createdAt),
        archivedAt: toISO(data.archivedAt),
        restoredAt: toISO(data.restoredAt),
      },
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] getLinkedPaymentArchive error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/archives/bookings/:bookingArchivesId/vehicle-inspection
 * Feeds the "View Vehicle Inspection" modal — before/after parts status +
 * photos for this one booking only, pulled directly from the live
 * inspection collections (they're never archived, see
 * bookingArchives.service.js's findLinkedInspectionDocs comment).
 */
export const getLinkedVehicleInspectionHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const bookingID = await resolveBookingID(bookingArchivesId);
    if (!bookingID) {
      return res.status(404).json({ success: false, message: "Archived booking not found." });
    }

    const data = await getInspectionRecordsForBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] getLinkedVehicleInspection error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/archives/bookings/:bookingArchivesId/booking-session
 * Feeds the "View Booking Session" modal — status, pickup/return time,
 * geofence zones/alerts, coding alerts, sourced from the preserved
 * bookingSessionArchives doc (not the map trail itself — see Traceback's
 * separate live/archive fallback for that).
 */
export const getLinkedBookingSessionHandler = async (req, res) => {
  try {
    const { bookingArchivesId } = req.params;
    const bookingID = await resolveBookingID(bookingArchivesId);
    if (!bookingID) {
      return res.status(404).json({ success: false, message: "Archived booking not found." });
    }

    const sessionDoc = await findLinkedBookingSessionArchive(bookingID);
    if (!sessionDoc) {
      return res.status(200).json({ success: true, data: null, message: "No linked booking session archive found for this booking." });
    }

    const data = sessionDoc.data();
    return res.status(200).json({
      success: true,
      data: {
        bookingSessionArchivesId: sessionDoc.id,
        ...data,
        createdAt:      toISO(data.createdAt),
        archiveDate:    toISO(data.archiveDate),
        archivedAt:     toISO(data.archivedAt),
        restoredAt:     toISO(data.restoredAt),
        lastArchivedAt: toISO(data.lastArchivedAt),
      },
    });
  } catch (error) {
    console.error("[BOOKING ARCHIVE] getLinkedBookingSession error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};