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
  extraFee: 0,
  status: "",         // "Paid" | "Pending" | "Refunded"
  discountAmount: 0,
  discountReason: "",
  discountBy: "",
  discountAt: null,
  // Set by applyDiscount() when a discount is applied to a booking that's
  // already fully (or partially) paid past what the new discount covers —
  // the spillover is cash that's now owed back to the customer. 0 means
  // the discount fit entirely within the outstanding balance, nothing to
  // return. See payments.service.js's computeAmounts()/applyDiscount().
  refundDue: 0,
  // Flipped true via markRefundIssued() once staff or the driver holding
  // the cash actually hands it back. Drives the "Refund Due" banner in
  // PaymentStatusModal and the Payments.jsx table/refund column.
  refundIssued: false,
  createdAt: null,
  updatedAt: null,
};