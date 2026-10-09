// cancellationRequests/{cancellationRequestID}
//
// One row per customer request to cancel a trip that is already ongoing.
// (Upcoming / unpaid bookings use the direct cancel and never create one.)
// This replaces the cancellationRequestStatus / cancellationRequestReason /
// cancellationRequestedAt / cancellationRejectReason / statusBeforeCancellationRequest
// fields that used to live on the booking document.
//
// Deliberately NOT part of refundRequests -- that collection is about money
// (amount, PayMongo ids, ...). This one is only about ending a trip in progress.
//
// A customer whose request was rejected can ask again, so a booking can have
// several rows; at most one is "pending" at a time.
export const CancellationRequest = {
  cancellationRequestID: "", // same as the Firestore doc ID
  bookingID:    "",   // FK -> bookings.bookingID (falls back to the booking doc ID for very old bookings)
  userID:       "",   // the customer who asked
  reason:       "",   // the customer's own free text
  status:       "",   // "pending" | "approved" | "rejected"
  requestedAt:  null,
  processedBy:  null, // uid of the staff member who approved/rejected
  processedAt:  null,
  rejectReason: null,
  type:         "request", // "request" = customer asked to end an ongoing trip | "direct" = booking cancelled outright
  cancelledBy:  null,      // direct rows: "customer" | "staff" | "admin" | "system" | "refund" | "unknown"
};
// A direct row is written with status "approved" at the moment the booking is
// cancelled (doc ID = the booking key); its `reason` is why the booking was
// cancelled. This replaces bookings.cancellationReason.