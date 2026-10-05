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

  // PayMongo's OWN transaction fee (what PayMongo keeps, NOT the gateway fee
  // the customer paid). Written only by the customer backend when an online
  // payment settles (utils/payments/paymongoFee.util.js) or by
  // customer-backend/scripts/backfillPaymongoFees.js. Admin only reads these.
  // Absent on cash payments and on payments settled before fee tracking.
  depositPaymongoFee: null,       // fee on the deposit-phase charge
  depositPaymongoFeeVat: null,    // VAT portion of that fee (estimate)
  depositPaymongoNet: null,       // net received for that charge
  depositPaymongoTaxes: null,
  balancePaymongoFee: null,       // same four, for the online balance charge
  balancePaymongoFeeVat: null,
  balancePaymongoNet: null,
  balancePaymongoTaxes: null,
  paymongoFeeTotal: null,         // deposit + balance fee
  paymongoFeeVatTotal: null,
  paymongoNetTotal: null,
  paymongoFeeVatIsEstimate: true, // true until PayMongo reports VAT explicitly
  paymongoFeeRecordedAt: null,
  // (All payment fields above are copied verbatim from the live payment doc
  // on archive and written back on restore.)
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