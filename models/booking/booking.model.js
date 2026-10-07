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
  serviceFee: 0,
  status: "",         // "upcoming" | "ongoing" | "completed" | "cancelled" | "cancellation_request" (shown while a request is pending) | "stolen"
  modeOfDriving: "",  // "With Chauffeur" | "Self Drive" — set at creation by the customer backend
  hasDevice: false,
  isReviewed: false,
  userRating: null,
  notesUser: "",
  notesAdmin: "",
  createdAt: null,

  // Who is driving is NOT stored on the booking. A chauffeur booking's current
  // driver is its "assigned" row in driverAssignments (see
  // models/driverAssignment/driverAssignment.model.js); a booking with no such
  // row is still in the dispatch queue. (driverID / driverAssignedAt /
  // driverAssignedBy used to live here.)
  //
  // Likewise a customer's request to cancel an ongoing trip is a row in
  // cancellationRequests, not fields on the booking. cancellationReason stays
  // here: it records why the booking ended up cancelled, whichever path was used.
  cancellationReason: null,
};