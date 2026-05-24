// Matches the 'transactionLogArchives' collection in Firestore
// Primary key: transactionLogArchivesId (Firestore document ID)
export const TransactionLogArchive = {
  transactionLogArchivesId: "", // Firestore doc ID — same as collection name + "Id"
  originalId: "",               // doc ID from original 'transactionLogs' collection
  transactionID: "",
  bookingID: "",
  userID: "",
  type: "",                     // "Payment" | "Refund" | "Deposit"
  amount: 0,
  status: "",                   // "Success" | "Failed" | "Pending" | "Refunded"
  paymentMethod: "",
  referenceNumber: "",
  createdAt: null,
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
  restoredBy: null,
};
