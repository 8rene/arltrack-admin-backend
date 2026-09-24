// Matches the 'refundRequests' collection, normally created by the customer
// backend. Admin backend usually only reads + transitions status here; it
// never creates a request on the customer's behalf (that's the customer's
// "Confirm & Send" step). The ONE exception: staffRefundBooking()
// (services/refundRequest/refundRequest.service.js) lets staff originate a
// refund directly when they force-cancel an upcoming booking while changing
// a car's status to Maintenance/Inactive. Those docs carry source: "staff"
// and start straight at "Approved" — there's no review step to sit in
// "Pending" for, since staff already decided.
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
  amount: 0,
  status: "Pending",
  paymongoRefundID: null,
  processedBy: null,
  processedAt: null,
  rejectReason: null,
  createdAt: null,
  updatedAt: null,
};