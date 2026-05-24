// Matches the actual 'bookings' collection in Firestore
export const Booking = {
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
  totalFee: 0,        // rentalFee + depositFee + serviceFee
  status: "",         // "pending" | "approved" | "completed" | "cancelled"
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  createdAt: null,
};
