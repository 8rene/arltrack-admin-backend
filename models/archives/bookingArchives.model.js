// Matches the 'bookingArchives' collection in Firestore.
// Primary key: bookingArchivesId (Firestore document ID)
//
// An archive is a COPY of the booking document, taken when the booking is deleted (see
// services/booking/bookingDelete.service.js), plus the bookkeeping fields below. So it has every column
// models/booking/booking.model.js has -- keep the two in step.
export const BookingArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  bookingArchivesId: "",   // Firestore doc ID of this archive document (the delete writes it as bookingArchivesID)
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
  restoredAt: null,        // present only if the booking had been restored before it was deleted again

  // Legacy: older bookings carried these; the live model no longer does (the amount comes from the payment).
  // depositFee, totalFee
};