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
  extrafee: 0,
  status: "",              // "Paid" | "Pending" | "Refunded"
  customerName: "",        // resolved at archive time
  createdAt: null,
  updatedAt: null,
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
  restoredBy: null,
};
