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
  userID:       "",   // the booking's customer (who asked, on a request; NOT necessarily who cancelled it on a direct row)
  reason:       "",   // the customer's own free text
  refundRequestID: null, // set on a row that belongs to a refund request: that row is decided through the refund, so the
                         // mid-trip request screens and the pending count skip it
  notes:        "",   // refund requests only: the customer's extra notes (moved here from refundRequests)
  status:       "",   // "pending" | "approved" | "rejected"
  createdAt:    null, // was requestedAt (old rows still carry that name; every reader accepts both)
  updatedAt:    null, // set when a request row is resolved, and stamped once on a direct row when it is written
  processedBy:  null, // uid of the staff / admin / owner who approved/rejected a request, who cancelled the booking directly
                      // (cancelledBy staff | admin), or who approved the refund that cancelled it (cancelledBy refund).
                      // null when nobody on staff was involved (customer or system cancel).
  processedAt:  null,
  rejectReason: null,
  cancelledBy:  null, // direct rows only: "customer" | "staff" | "admin" | "system" | "refund" | "unknown".
                      // There is no `type` field: a row with cancelledBy is a direct cancellation, any other row
                      // is a customer request to end an ongoing trip.
};
// A direct row is written at the moment the booking is cancelled (doc ID = the booking key), already finished:
// status "approved", processedAt / createdAt / updatedAt all stamped with the cancellation, processedBy = the staff
// member behind it when there is one. Its `reason` is why the booking was cancelled. This replaces
// bookings.cancellationReason. (Rows from before this change have no processedBy / status / updatedAt.)