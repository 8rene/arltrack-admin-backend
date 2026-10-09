// Matches the 'transactionLogs' collection in Firestore.
// Primary key: transactionLogsID (Firestore document ID)
//
// Written by createTransactionLog() in services/transactionLogs/transactionLogs.service.js.
// One entry per completed money event — NOT per state change. A refund
// request sitting at "Pending" does not get an entry here; only once it
// resolves (Refunded / Failed / Rejected) does the outcome land in this
// ledger. See refundRequests for the in-progress workflow state.
//
// Money-only: company costs (e.g. maintenance bills) are NOT in this ledger --
// maintenance.totalCost is their only copy. Every type always logs one final
// settled amount, never a delta — a correction or reversal is its own
// full-amount entry, not a diff.
export const TransactionLog = {
  transactionLogsID: "",     // Firestore doc ID
  bookingID: "",          // FK -> bookings
  paymentID: "",          // FK -> payments
  userID: "",             // FK -> user, the customer the money event belongs to
  // Link to the record that caused this entry -- one column per kind, at most one is set (there is no
  // refundRequestID / refID / refCollection column):
  refundReqID: null,      // FK -> refundRequests (type "Refund" via that flow)
  paymentEntryID: null,   // FK -> paymentEntries: the row that was settled (type "Payment"). A log that covers several
                          //   entries at once (one settled total) leaves this null; use paymentID to find them.
  penaltyID: null,        // FK -> penalties: a penalty payment that covered exactly ONE penalty. A payment that covered
                          //   several leaves this null (its paymentEntries rows share a groupID).
  // Discount / DepositReturn / discount-spillover refunds have no source record, so all four stay null.

  type: "",               // "Payment" | "Refund" | "Deposit" | "DepositReturn" | "Discount"
  amount: 0,
  status: "",             // "Success" | "Failed" | "Pending" | "Refunded" | "Rejected"

  paymentMethod: "",      // e.g. "GCash", "Cash", "Maya"
  referenceNumber: "",

  description: "",        // short free-text context, e.g. "Discount applied at pickup"
  performedBy: null,      // admin userID if staff-triggered (discount, reject, expense); null if customer/webhook-triggered

  createdAt: null,
};