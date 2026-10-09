// Matches the 'bookingArchives' collection in Firestore.
//
// An archive is a COPY of the booking document, taken when the booking is deleted (see
// services/booking/bookingDelete.service.js), plus the bookkeeping fields below. So it has every column
// models/booking/booking.model.js has -- keep the two in step. In particular it does not store the driver
// (driverAssignments), a cancellation request or reason (cancellationRequests), or the fee totals (the payment).
export const BookingArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  bookingArchivesID: "",   // Firestore doc ID of this archive document (lowercase "ID")
  originalId: "",          // doc ID of the original 'bookings' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
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
  status: "",              // same values as a live booking
  modeOfDriving: "",       // "With Chauffeur" | "Self Drive"
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  createdAt: null,
};