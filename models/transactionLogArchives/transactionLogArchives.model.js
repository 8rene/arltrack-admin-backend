// Matches the 'transactionLogArchives' collection in Firestore
// Primary key: transactionLogArchivesId (Firestore document ID)
export const TransactionLogArchive = {
  transactionLogArchivesId: "", // Firestore doc ID — same as collection name + "Id"
  originalId: "",               // doc ID from original 'transactionLogs' collection
  transactionID: "",
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
  restoredAt: null,
  restoredBy: null,
};