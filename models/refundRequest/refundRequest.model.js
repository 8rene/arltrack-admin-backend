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
  toRefundAmount: 0,   // what goes back to the customer (was `amount`)
  bookingPaid: 0,      // everything the customer had paid before any forfeit (was `grossPaid`)
  returnDeposit: true, // the 48-hour rule's verdict when the request was made: true = the deposit goes back, false = it
                       // is kept. Replaces policyTier / pickupAt / hoursBeforePickup. A missing value = a full refund.
  depositForfeited: 0,
  forfeitWaived: false,
  // parts[] (one PayMongo refund per online charge), manualRefund (the in-person hand-back) and unrefundable[]
  // (online money with no PayMongo payment id -- never refunded, never handed back) are NOT stored here any more:
  // they are the "out" rows in paymentEntries (refundReqID = this request, ids <id>_part<n> | _manual | _unrefundable<n>).
  // hydrateRefundRequests() rebuilds the old shape, incl. unrefundableAmount (their sum), for readers.
  // paymongoRefundIDs is only the lookup key the customer backend's refund.updated webhook queries.
  //
  // ALSO NOT STORED (derived, so there is one place for each fact):
  //   onlineAmount / manualAmount   sums of this request's "out" rows (hydrateRefundRequest fills them for readers)
  //   forfeitWaivedAmount           the deposit that was not kept; only the boolean forfeitWaived is stored. The staff
  //                                 reason for a waive is in the audit log line written when the request is approved.
  //   customerNotified              whether the customer was told is not data about the refund: the notification goes
  //                                 out when the status moves to Approved / Rejected (a staff-refund retry sends it only
  //                                 if that call is the one that cancelled the booking).
  //   requestedAt                   same moment as createdAt; readers use createdAt (old docs may still carry it).
  //   policyTier / pickupAt / hoursBeforePickup   replaced by returnDeposit. Until the customer backend writes it,
  //                                 requests still carry the old snapshot and the admin reads that (policyForRequest).
  //   amount / grossPaid            old names of toRefundAmount / bookingPaid. Old documents and the customer backend
  //                                 still use them, so every reader accepts both and the API returns both for now.
  status: "Pending",
  paymongoRefundIDs: [],
  processedBy: null,
  processedAt: null,
  rejectReason: null,
  createdAt: null,
  updatedAt: null,
};