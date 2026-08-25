// Matches the 'transactionLogs' collection in Firestore.
// Primary key: transactionLogsID (Firestore document ID)
//
// Written by createTransactionLog() in services/transactionLogs/transactionLogs.service.js.
// One entry per completed money event — NOT per state change. A refund
// request sitting at "Pending" does not get an entry here; only once it
// resolves (Refunded / Failed / Rejected) does the outcome land in this
// ledger. See refundRequests for the in-progress workflow state.
export const TransactionLog = {
  transactionLogsID: "",     // Firestore doc ID
  bookingID: "",          // FK -> bookings
  paymentID: "",          // FK -> payments
  refundRequestID: null,  // FK -> refundRequests, only set when type === "Refund" via that flow
  userID: "",             // FK -> user (the customer the money event belongs to)

  type: "",               // "Payment" | "Refund" | "Deposit" | "Discount"
  amount: 0,
  status: "",             // "Success" | "Failed" | "Pending" | "Refunded" | "Rejected"

  paymentMethod: "",      // e.g. "GCash", "Cash", "Maya"
  referenceNumber: "",

  description: "",        // short free-text context, e.g. "Discount applied at pickup"
  performedBy: null,      // admin userID if staff-triggered (discount, reject); null if customer/webhook-triggered

  createdAt: null,
};