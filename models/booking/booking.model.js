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
  status: "",         // "upcoming" | "ongoing" | "completed" | "cancelled" | "cancellation_request" | "stolen"
  modeOfDriving: "",  // "With Chauffeur" | "Self Drive" — set at creation by the customer backend
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  createdAt: null,

  // ── Driver Dispatch (added for chauffeur assignment) ──────────
  // Only meaningful when modeOfDriving === "With Chauffeur". Unset/null
  // means the booking is still sitting in the dispatch queue.
  driverID:         null, // FK -> user/{uid} where roleID resolves to "Driver"
  driverAssignedAt: null,
  driverAssignedBy: null, // username/uid of the Owner/Admin/Supervisor who assigned it
};