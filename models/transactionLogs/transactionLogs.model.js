// Matches the 'transactionLogs' collection in Firestore.
// Primary key: transactionLogsID (Firestore document ID)
//
// Written by createTransactionLog() in services/transactionLogs/transactionLogs.service.js.
// One entry per completed money event — NOT per state change. A refund
// request sitting at "Pending" does not get an entry here; only once it
// resolves (Refunded / Failed / Rejected) does the outcome land in this
// ledger. See refundRequests for the in-progress workflow state.
//
// "Expense" entries are the one exception to "customer-facing": a company
// cost (e.g. a maintenance bill) with no booking/payment/customer, so
// bookingID/paymentID/userID are null on those. Every type, Expense
// included, always logs one final settled amount, never a delta — a
// correction or reversal is its own full-amount entry, not a diff.
export const TransactionLog = {
  transactionLogsID: "",     // Firestore doc ID
  bookingID: "",          // FK -> bookings (null for "Expense")
  paymentID: "",          // FK -> payments (null for "Expense")
  refundRequestID: null,  // FK -> refundRequests, only set when type === "Refund" via that flow
  userID: "",             // FK -> user, the customer the money event belongs to (null for "Expense")
  refID: null,             // generic FK for non-booking types, e.g. a carMaintenance doc ID for "Expense"
  refCollection: null,     // which collection refID points into, e.g. "carMaintenance"

  type: "",               // "Payment" | "Refund" | "Deposit" | "Discount" | "Expense"
  amount: 0,
  status: "",             // "Success" | "Failed" | "Pending" | "Refunded" | "Rejected"

  paymentMethod: "",      // e.g. "GCash", "Cash", "Maya"
  referenceNumber: "",

  description: "",        // short free-text context, e.g. "Discount applied at pickup"
  performedBy: null,      // admin userID if staff-triggered (discount, reject, expense); null if customer/webhook-triggered

  createdAt: null,
};