// paymentEntries/{paymentEntryID}
//
// ONE ROW PER MONEY MOVEMENT against a payment, penalty or refund. This is the
// normalized replacement for everything that used to be embedded:
//   - payments.paymongoTransactions[]                  (deposit / balance attempts)
//   - payments.*PaymongoPaymentID / *PaymongoFee / paymongoChannel /
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
// Money in  -> direction "in"  (customer paid)
// Money out -> direction "out" (a refund)
//     <refundRequestID>_part<n>          one PayMongo refund        (source "online",    referenceNumber = re_...)
//     <refundRequestID>_manual           staff hand-back in person  (source "in_person") -- cash taken in person ONLY
//     <refundRequestID>_unrefundable<n>  paid online but NO PayMongo payment id: status "unrefundable", with the
//                                        transactionErrorNote "Payment ID does not exist". It is reported, never
//                                        handed back.
//     <paymentID>_discountrefund         cash handed back for a staff discount that exceeded what was owed
//                                        (source "in_person", method "cash", refundReqID null: no refund request
//                                        exists for it). Written by markRefundIssued() in the same batch as
//                                        payments.refundIssued.
// The "out" rows ARE the source of truth for a refund: refundRequests no longer stores parts[] / manualRefund /
// unrefundable[] (writeRefundEntries commits them with the status change; hydrateRefundRequests rebuilds the
// old shape for readers). A request that still carries those fields (not yet cleaned up) wins in hydrate.
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

export const PaymentEntry = {
  paymentEntryID: "",       // same as the Firestore doc ID. Deposit/balance rows: "<paymentID>_deposit" | "<paymentID>_balance"
                            // (same key the transaction-log idempotency already uses). Penalty / later attempts: auto ID.
  paymentID:   null,        // FK -> payments.paymentID. ALWAYS the payment this money movement belongs to (null only for an old penalty whose payment is unknown)
  bookingID:   null,        // FK -> bookings.bookingID
  userID:      null,        // FK -> user (the customer)
  refundReqID: null,        // FK -> refundRequests.refundRequestID. Set ONLY on "out" rows created by a refund request.
  penaltyID:   null,        // FK -> penalties.penaltyID. Set ONLY on phase "penalty" rows.
  direction:   "in",        // "in" | "out"
  phase:       "deposit",   // "deposit" | "balance" | "penalty"   (for "out": the phase being refunded)
  source:      "online",    // "online" | "in_person"
  method:      null,        // gcash | maya | qrph | cash | bank_transfer | null (online, channel unknown)
  amount:      0,           // pesos moved by THIS entry
  status:      "pending",   // pending | success | failed | cancelled | unrefundable
  referenceNumber: null,    // the external id of this movement: pay_... (online), re_... (online refund),
                            // receipt / bank code (in person). null if none. Never "N/A" / "—" / "".
  sessionID:   null,        // PayMongo checkout session (online "in" rows) -- webhook lookup key
  transactionFee: null,     // PayMongo's actual fee for this charge (NOT payments.gatewayFee, which is
                            // what the customer was charged from system settings)
  processedBy: null,        // staff uid who confirmed / handed back (in person). null for online + webhooks
  processedAt: null,
  settledAt:   null,        // when the money actually moved
  groupID:     null,        // rows created by ONE payment that covered several penalties share this
  transactionErrorNote: null, // why this movement failed / could not be refunded (e.g. a PayMongo refund error,
                            // "Payment ID does not exist"). null unless status is "failed" or "unrefundable".
  createdAt:   null,
  updatedAt:   null,
};

// Indexes the app relies on (Firestore creates single-field ones automatically):
//   paymentID + phase           list a payment's entries
//   refundReqID                 a refund request's "out" rows (queried with `in`)
//   penaltyID                   a penalty's rows (queried with `in`)
//   referenceNumber + direction webhook lookup (STEP 2)
//   sessionID                   webhook lookup
//   bookingID                   permanent-delete cleanup
