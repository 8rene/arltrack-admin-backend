// Matches the 'transactionLogArchives' collection in Firestore
// Primary key: transactionLogArchivesId (Firestore document ID)
export const TransactionLogArchive = {
  transactionLogArchivesId: "", // Firestore doc ID — same as collection name + "Id"
  originalId: "",               // doc ID from original 'transactionLogs' collection
  transactionLogsID: "",
  bookingID: "",
  paymentID: "",                // FK -> payments (new — lets an archived entry still be traced back)
  refundRequestID: null,        // FK -> refundRequests, only set when type === "Refund" via that flow
  userID: "",
  type: "",                     // "Payment" | "Refund" | "Deposit" | "Discount"
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
  // marking it. restoredAt can still show up here though, inherited from
  // the live transaction log doc if it's ever archived again after being
  // restored. restoredBy was previously written directly to this doc on
  // restore but that write path no longer exists, so it's been removed
  // from this model.
  restoredAt: null,
};