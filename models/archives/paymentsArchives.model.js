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

  // PayMongo's OWN fee (what PayMongo keeps; NOT the gateway fee the customer
  // paid). Written by the customer backend when an online payment settles, or
  // by its backfillPaymongoFees.js script. Admin only reads these. Absent on
  // cash payments and on payments settled before fee tracking.
  // Sales margin = gatewayFee - paymongoFeeTotal.
  depositPaymongoFee: null,   // fee on the deposit-phase online charge
  balancePaymongoFee: null,   // fee on the online balance charge (Partial only)
  paymongoFeeTotal: null,     // deposit + balance
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