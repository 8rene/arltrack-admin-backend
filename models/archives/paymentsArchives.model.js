// Matches the actual 'payments' collection in Firestore
export const Payment = {
  paymentID: "",
  bookingID: "",
  paymentMethod: "",  // e.g. "Cash", "GCash"
  amount: 0,          // deposit amount (partial)
  rentalFee: 0,
  serviceFee: 0,
  extraFee: 0,
  driversFee: 0,        // chauffeur fee (0 when self-drive)
  gatewayFee: 0,        // payment-gateway fee charged to the customer (peso amount)
  securityDeposit: 0,   // refundable deposit, already inside `amount`

  // Percentage fees, snapshotted at booking time so a later Settings change
  // never alters an existing booking. 0 on bookings made before percent fees.
  serviceFeeRate: 0,    // % of the RENTAL FEE only
  gatewayFeeRate: 0,    // % of gatewayFeeBase
  gatewayFeeBase: 0,    // rental + extra + driver's + service fee + security deposit

  // PayMongo's OWN fee (what PayMongo keeps; NOT the gateway fee the customer
  // paid). Written by the customer backend when an online payment settles, or
  // by its backfillPaymongoFees.js script. Admin only reads these. Absent on
  // cash payments and on payments settled before fee tracking.
  // Sales margin = gatewayFee - paymongoFeeTotal.
  depositPaymongoFee: null,   // fee on the deposit-phase online charge
  balancePaymongoFee: null,   // fee on the online balance charge (Partial only)
  paymongoFeeTotal: null,     // deposit + balance
  // LEGACY: rebuilt for readers from the paymentEntries rows (hydratePayment / entriesToLegacyTransactions).
  // Nothing writes it any more -- the money movements live in paymentEntries (see models/paymentEntries).
  paymongoTransactions: [],
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