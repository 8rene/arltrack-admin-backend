// Matches the 'bookingArchives' collection in Firestore
// Primary key: bookingArchivesId (Firestore document ID)
export const BookingArchive = {
  bookingArchivesId: "",   // Firestore doc ID — same as collection name + "Id"
  originalId: "",          // doc ID from original 'bookings' collection
  bookingID: "",
  carID: "",
  userID: "",
  location: "",
  startDateTime: null,
  endDateTime: null,
  totalDays: 0,
  rentalFee: 0,
  depositFee: 0,
  serviceFee: 0,
  totalFee: 0,
  status: "",              // "pending" | "approved" | "completed" | "cancelled"
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  customerName: "",        // resolved at archive time
  createdAt: null,
  archivedAt: null,
  archivedBy: "",
  // Restore deletes this doc entirely (see restoreBookingArchive in
  // services/archives/bookingArchives.service.js) rather than marking it
  // restoredAt — a restored booking's history lives in the audit log
  // instead. This field can still show up here, though: restoring sets
  // restoredAt on the *live* booking doc, and if that booking is archived
  // again later, the archive-write spreads the live doc's fields
  // (including that restoredAt) straight into the next archive doc.
  // restoredBy was previously written directly to this doc on restore but
  // that write path no longer exists, so it's been removed from this model.
  restoredAt: null,
};