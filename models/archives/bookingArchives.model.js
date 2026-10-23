// Matches the 'bookingArchives' collection in Firestore.
// Primary key: bookingArchivesID (Firestore document ID)
//
// An archive is a COPY of the booking document, taken when the booking is deleted (see
// services/booking/bookingDelete.service.js), plus the bookkeeping fields below. So it has every column
// models/booking/booking.model.js has -- keep the two in step.
export const BookingArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  bookingArchivesID: "",   // Firestore doc ID of this archive document
  originalId: "",          // doc ID of the original 'bookings' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",
  restoredBy: null,
  customerName: "",        // resolved on read from userID; not stored on restore

  // ---- copied from the booking document (see booking.model.js) ----
  bookingID: "",
  carID: "",
  userID: "",
  location: "",
  startDateTime: null,
  endDateTime: null,
  totalDays: 0,
  rentalFee: 0,
  serviceFee: 0,
  status: "",              // "to pay" | "upcoming" | "ongoing" | "completed" | "cancelled" | "cancellation_request" | "stolen"
  modeOfDriving: "",       // "With Chauffeur" | "Self Drive"
  serviceType: "",         // free-text label the customer picked (or typed for "Others")
  serviceTypeID: null,     // FK -> serviceType; null for "Others"
  pickupAt: null,          // exact pickup instant (Manila, UTC+8), written by the customer backend
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  termsVersionID: "",
  termsAcceptedAt: null,
  notesAdmin: "",
  createdAt: null,
  updatedAt: null,
  completedAt: null,

  // Legacy: older bookings carried these; the live model no longer does (the amount comes from the payment).
  // depositFee, totalFee
};