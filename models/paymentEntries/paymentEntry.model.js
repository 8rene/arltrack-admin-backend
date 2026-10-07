// paymentEntries/{paymentEntryID}
//
// ONE ROW PER MONEY MOVEMENT against a payment, penalty or refund. This is the
// normalized replacement for everything that used to be embedded:
//   - payments.paymongoTransactions[]                  (deposit / balance attempts)
//   - payments.*PaymongoPaymentID / *PaymongoFee / paymongoChannel / proofUrl /
//     paidAt / balancePaidAt / confirmedBy / confirmedAt / balanceMethod /
//     balanceCollectedBy / balanceCollectedAt          (scattered per-phase facts)
//   - penalties.paymentMethod / referenceNumber / paidAt  (overwritten on every payment)
//   - refundRequests.parts[] / manualRefund            (STEP 2 -- direction "out")
//
// NOTE: payments.paymongoSessionID and payments.checkoutUrl STAY on payments -- the webhook finds the
// payment by that session id, and they describe the one checkout that is open right now. The entry
// also records sessionID so every attempt keeps its own history.
//
// payments, penalties and refundRequests stay as the parent documents (totals,
// workflow, review). paymentEntries only holds the money movements.
//
// Money in  -> direction "in"  (customer paid)       <- built in STEP 1 (this release)
// Money out -> direction "out" (refund / hand-back)  <- STEP 2 (refunds), not yet written
//
// The row is the source of truth for "did this money move, how, and what is its
// external reference". Anything totalling entries MUST filter on direction.
//
// Deposit offsets (penalties covered by the held security deposit) and staff
// discounts are NOT entries: no money moves, they are adjustments and stay on
// payments (deposit.settlement, discountAmount ...).

export const ENTRY_COLLECTION = "paymentEntries";

export const ENTRY_DIRECTIONS = ["in", "out"];
export const ENTRY_PHASES     = ["deposit", "balance", "penalty"];
export const ENTRY_SOURCES    = ["online", "in_person"];            // PayMongo | staff collected / handed back
export const ENTRY_METHODS    = ["gcash", "maya", "qrph", "cash", "bank_transfer"];   // customers can only pay online via gcash / maya / qrph
// "unrefundable" is only used by direction "out" rows (an amount with no PayMongo payment id).
export const ENTRY_STATUSES   = ["pending", "success", "failed", "cancelled", "unrefundable"];

// Flags a row can carry (free text is allowed -- these are the ones the code sets):
//   missing_payment_id    online + success but no pay_... id was ever saved
//   refunded_legacy       the legacy payment said "Refunded" -- STEP 2 creates the matching "out" row
//   amount_inferred       amount was derived (total - deposit), not read from a recorded value
//   discount_review       a staff discount exists and the paid amount could not be confirmed
//   legacy_aggregate      penalty rows built from the old overwritten fields (one row = everything paid)
//   method_unmapped:<raw> the old method text did not match any known method
export const ENTRY_FLAGS = [
  "missing_payment_id", "refunded_legacy", "amount_inferred",
  "discount_review", "legacy_aggregate",
];

export const PaymentEntry = {
  paymentEntryID: "",       // same as the Firestore doc ID. Deposit/balance rows: "<paymentID>_deposit" | "<paymentID>_balance"
                            // (same key the transaction-log idempotency already uses). Penalty / later attempts: auto ID.
  paymentID:   null,        // FK -> payments.paymentID
  bookingID:   null,        // FK -> bookings.bookingID
  userID:      null,        // FK -> user (the customer)
  refID:       "",          // source record this movement belongs to
  refCollection: "",        //   "payments" | "penalties" | "refundRequests"   (same pattern as transactionLogs)
  direction:   "in",        // "in" | "out"
  phase:       "deposit",   // "deposit" | "balance" | "penalty"   (for "out": the phase being refunded)
  parentEntryID: null,      // "out" rows: the "in" entry being refunded
  source:      "online",    // "online" | "in_person"
  method:      null,        // gcash | maya | qrph | cash | bank_transfer | null (online, channel unknown)
  amount:      0,           // pesos moved by THIS entry
  status:      "pending",   // pending | success | failed | cancelled | unrefundable
  referenceNumber: null,    // the external id of this movement: pay_... (online), re_... (online refund),
                            // receipt / bank code (in person). null if none. Never "N/A" / "—" / "".
  sessionID:   null,        // PayMongo checkout session (online "in" rows) -- webhook lookup key
  transactionFee: null,        // PayMongo's actual fee for this charge (NOT payments.gatewayFee, which is
                            // what the customer was charged from system settings)
  proofUrl:    null,
  processedBy: null,        // staff uid who confirmed / handed back (in person). null for online + webhooks
  processedAt: null,
  settledAt:   null,        // when the money actually moved
  groupID:     null,        // rows created by ONE payment that covered several penalties share this
  note:        null,        // explanation / error text (e.g. why a refund part failed, "Payment ID does not exist")
  flags:       [],
  migratedFrom: null,       // set only by the migration script, e.g. "payments.legacy"
  createdAt:   null,
  updatedAt:   null,
};

// Indexes the app relies on (Firestore creates single-field ones automatically):
//   paymentID + phase           list a payment's entries
//   refCollection + refID       (queried as refID `in` [...] and filtered in memory)
//   referenceNumber + direction webhook lookup (STEP 2)
//   sessionID                   webhook lookup
//   bookingID                   permanent-delete cleanup
