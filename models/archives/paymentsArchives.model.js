// Matches the 'paymentsArchives' collection in Firestore
// Primary key: paymentsArchivesId (Firestore document ID)
export const PaymentsArchive = {
  paymentsArchivesId: "",  // Firestore doc ID — same as collection name + "Id"
  originalId: "",          // doc ID from original 'payments' collection
  bookingID: "",
  paymentMethod: "",       // e.g. "Cash", "GCash"
  referenceNumber: "",
  proofUrl: "",
  amount: 0,
  rentalFee: 0,
  depositFee: 0,
  serviceFee: 0,
  extraFee: 0,
  status: "",              // "Paid" | "Pending" | "Refunded"
  customerName: "",        // resolved at archive time
  createdAt: null,
  updatedAt: null,
  archivedAt: null,
  archivedBy: "",
  // Restore deletes this doc entirely (see restorePaymentsArchive in
  // services/archives/paymentsArchives.service.js) rather than marking it.
  // restoredAt can still show up here though, inherited from the live
  // payment doc if it's ever archived again after being restored.
  // restoredBy was previously written directly to this doc on restore but
  // that write path no longer exists, so it's been removed from this model.
  restoredAt: null,
};