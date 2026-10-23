// Matches the 'transactionLogArchives' collection in Firestore
// Primary key: transactionLogArchivesId (Firestore document ID)
export const TransactionLogArchive = {
  transactionLogArchivesId: "", // Firestore doc ID — same as collection name + "Id"
  originalId: "",               // doc ID from original 'transactionLogs' collection
  transactionLogsID: "",
  bookingID: "",
  paymentID: "",                // FK -> payments (new — lets an archived entry still be traced back)
  refundReqID: null,            // FK -> refundRequests (Refund via a refund request)
  paymentEntryID: null,         // FK -> paymentEntries (the row a Payment log settled)
  penaltyID: null,              // FK -> penalties (a payment that covered exactly one penalty)
  userID: "",
  type: "",                     // "Payment" | "Refund" | "Deposit" | "DepositReturn" | "Discount"
  amount: 0,
  status: "",                   // "Success" | "Failed" | "Pending" | "Refunded" | "Rejected"
  paymentMethod: "",
  referenceNumber: "",
  description: "",              // short free-text context (new)
  performedBy: null,            // admin userID if staff-triggered; null if customer/webhook-triggered (new)
  createdAt: null,
  archivedAt: null,
  archivedBy: "",
  // Restore deletes this doc entirely (see restoreTransactionLogArchive in
  // services/archives/transactionLogArchives.service.js) rather than
  // marking it, and writes no restore stamp onto the live transaction log.
};