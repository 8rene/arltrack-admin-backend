// Matches the 'refundRequests' collection, normally created by the customer
// backend. Admin backend usually only reads + transitions status here; it
// never creates a request on the customer's behalf (that's the customer's
// "Confirm & Send" step). The ONE exception: staffRefundBooking()
// (services/refundRequest/refundRequest.service.js) lets staff originate a
// refund directly when they force-cancel an upcoming booking while changing
// a car's status to Maintenance/Inactive. Those docs carry source: "staff"
// and an outcome field ("refunded" | "already_refunded" | "nothing_owed" —
// the latter two mean no money actually moved, see staffRefundBooking()'s
// comment) — status starts straight at "Approved" for a real refund, or
// goes directly to "Refunded" for the other two since there's nothing left
// to do. No review step to sit in "Pending" for either way, since staff
// already decided. getResolvedBookingsForCar() (services/fleet/fleet.
// service.js) reads these back by bookingID so the status-change screen can
// show what already happened on a retry after a partial batch failure.
//
// status flow:
//   "Pending"  → waiting for admin review
//   "Approved" → admin approved; PayMongo refund created, waiting for
//                PayMongo to confirm via the refund.updated webhook
//                (handled on the customer backend, which owns that webhook)
//   "Refunded" → PayMongo confirmed success
//   "Rejected" → admin rejected, never sent to PayMongo
//   "Failed"   → PayMongo confirmed the refund failed after approval
export const RefundRequest = {
  refundRequestID: "",
  bookingID: "",
  paymentID: "",
  userID: "",
  reason: "",
  notes: "",
  source: "customer", // "customer" (default) | "staff" — see comment above
  outcome: null, // "refunded" | "already_refunded" | "nothing_owed" — staff-origin docs only
  amount: 0,
  // parts[] (one PayMongo refund per online charge), manualRefund (the in-person hand-back) and unrefundable[]
  // (online money with no PayMongo payment id -- never refunded, never handed back) are NOT stored here any more:
  // they are the "out" rows in paymentEntries (refID = this request, ids <id>_part<n> | _manual | _unrefundable<n>).
  // hydrateRefundRequests() rebuilds the old shape, incl. unrefundableAmount (their sum), for readers.
  // paymongoRefundIDs is only the lookup key the customer backend's refund.updated webhook queries.
  status: "Pending",
  paymongoRefundIDs: [],
  processedBy: null,
  processedAt: null,
  rejectReason: null,
  createdAt: null,
  updatedAt: null,
};