// Matches the 'paymentEntryArchives' collection in Firestore.
//
// An archive is a COPY of every paymentEntries row of a booking (deposit, balance, penalty, refund "out" rows and
// the deposit return), taken when the booking is deleted (see services/booking/bookingDelete.service.js and
// services/archives/linkedArchives.service.js), plus the bookkeeping fields below. So it has every column
// models/paymentEntries/paymentEntry.model.js has -- keep the two in step.
//
// The archive document id IS the live paymentEntryID ("<paymentID>_deposit", "<refundRequestID>_part1" ...), so a
// restore writes the row back under the same id and the idempotency / webhook lookups keep working.
//
// The Payments, Penalty and Refund archive pages read their method / reference / paid date / refund parts from these
// rows (services/archives/entryArchiveHydrate.service.js looks in paymentEntries AND here). Restoring a payment, penalty,
// refund or booking moves its rows back and deletes these documents; the live row gets no restoredAt.
export const PaymentEntryArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  paymentEntryArchivesID: "",  // Firestore doc ID of this archive document (= originalId)
  originalId: "",          // doc ID of the original 'paymentEntries' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",

  // ---- copied from the paymentEntries document (see paymentEntry.model.js) ----
  paymentEntryID: "",
  paymentID: null,
  bookingID: null,
  userID: null,
  refundReqID: null,       // set on a refund's "out" rows only
  penaltyID: null,         // set on "penalty" phase rows only
  direction: "in",         // "in" | "out"
  phase: "deposit",        // "deposit" | "balance" | "penalty" | "deposit_return" | "discount"
  source: "online",        // "online" | "in_person"
  method: null,
  amount: 0,
  status: "pending",       // pending | success | failed | cancelled | unrefundable
  referenceNumber: null,
  sessionID: null,
  transactionFee: null,
  processedBy: null,
  processedAt: null,
  settledAt: null,
  groupID: null,
  transactionErrorNote: null,
  createdAt: null,
  updatedAt: null,
};