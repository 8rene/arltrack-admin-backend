// Matches the 'paymentsArchives' collection in Firestore.
//
// An archive is a COPY of the payment document, taken when its booking is deleted (see
// services/booking/bookingDelete.service.js), plus the bookkeeping fields below. So it has every column
// models/payment/payment.model.js has -- keep the two in step.
//
// Like the live payment, an archive does not store referenceNumber, proofUrl, or the PayMongo ids / fees /
// channel / paymongoTransactions: those are paymentEntries rows (paymentEntries.paymentID = this paymentID,
// and the entries are NOT archived with it). The Payments Archive page gets them back through
// hydratePayments(). Older archives that still carry copies of those fields are cleaned by
// scripts/clean-leftovers.js.
export const PaymentsArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  paymentsArchivesID: "",  // Firestore doc ID of this archive document (lowercase "ID")
  originalId: "",          // doc ID of the original 'payments' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
  restoredBy: null,
  customerName: "",        // resolved on read from the booking's userID; not stored on restore

  // ---- copied from the payment document (see payment.model.js) ----
  paymentID: "",
  bookingID: "",
  userID: "",
  paymentMethod: "",       // the customer's chosen channel, e.g. "gcash"
  methodOfPayment: "",     // "Full" | "Partial"
  amount: 0,
  rentalFee: 0,
  serviceFee: 0,
  extraFee: 0,
  driversFee: 0,
  gatewayFee: 0,
  securityDeposit: 0,
  serviceFeeRate: 0,
  gatewayFeeRate: 0,
  gatewayFeeBase: 0,
  balanceAmount: 0,
  balanceStatus: "",       // "not_applicable" | "not_due" | "pending" | "paid" | "cancelled"
  currentPhase: "",        // "deposit" | "balance"
  status: "",              // "paid" | "pending" | "cancelled" | "Refunded" ...
  // paymongoSessionID is not stored: the session id is paymentEntries.sessionID (read back by hydratePayment).
  checkoutUrl: "",
  discountAmount: 0,
  discountReason: "",
  discountBy: "",
  discountAt: null,
  refundDue: 0,
  refundIssued: false,
  createdAt: null,
  updatedAt: null,
};