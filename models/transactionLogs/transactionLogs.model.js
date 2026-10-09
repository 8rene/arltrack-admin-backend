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
  userID: "",             // FK -> user, the customer the money event belongs to (null for "Expense")
  // The record that caused this entry. At most ONE of these is set (the rest stay null):
  refundReqID: null,      // FK -> refundRequests.refundRequestID (type "Refund" via a refund request)
  paymentEntryID: null,   // FK -> paymentEntries.paymentEntryID, the row that was settled (type "Payment"). A log that covers
                          // several entries at once (one settled total) leaves this null; use paymentID to find them.
  maintenanceID: null,    // FK -> maintenance.maintenanceID (type "Expense")
  // Discount / DepositReturn / discount-spillover refunds have no source record, so all three stay null.

  type: "",               // "Payment" | "Refund" | "Deposit" | "DepositReturn" | "Discount" | "Expense"
  amount: 0,
  status: "",             // "Success" | "Failed" | "Pending" | "Refunded" | "Rejected"

  paymentMethod: "",      // lowercase code, same enum as paymentEntries.method: "gcash" | "maya" | "qrph" | "cash" | "bank_transfer" | "" (none)
  referenceNumber: "",    // pay_... / re_... / receipt code. "" when there is none (never "—" or "N/A")

  description: "",        // short free-text context, e.g. "Discount applied at pickup"
  performedBy: null,      // admin userID if staff-triggered (discount, reject, expense); null if customer/webhook-triggered

  createdAt: null,
};

// Indexes the app relies on (single-field ones are automatic; this one is composite and must be created):
//   maintenanceID + status      rejectTransactionLogsByMaintenance() -- replaces the old refID + refCollection + status index
