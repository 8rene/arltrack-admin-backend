// Matches the 'refundRequests' collection created by the customer backend.
// Admin backend only ever reads + transitions status here; it never
// creates new refund requests (that's the customer's "Confirm & Send" step).
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
  amount: 0,
  status: "Pending",
  paymongoRefundID: null,
  processedBy: null,
  processedAt: null,
  rejectReason: null,
  createdAt: null,
  updatedAt: null,
};
