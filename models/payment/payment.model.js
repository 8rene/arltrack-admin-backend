// Matches the actual 'payments' collection in Firestore
export const Payment = {
  paymentID: "",
  bookingID: "",
  paymentMethod: "",  // e.g. "Cash", "GCash"
  referenceNumber: "", // "N/A" for cash
  proofUrl: "",
  amount: 0,          // deposit amount (partial)
  rentalFee: 0,
  depositFee: 0,
  serviceFee: 0,
  extrafee: 0,
  status: "",         // "Paid" | "Pending" | "Refunded"
  createdAt: null,
  updatedAt: null,
};
