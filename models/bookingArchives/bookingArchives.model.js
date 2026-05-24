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
  restoredAt: null,
  restoredBy: null,
};
