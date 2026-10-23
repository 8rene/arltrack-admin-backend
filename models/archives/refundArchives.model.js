// Matches the 'refundArchives' collection in Firestore.
//
// An archive is a COPY of the refund request document, taken when its booking is deleted (see
// services/booking/bookingDelete.service.js -- there is no standalone "delete this refund request" action), plus the
// bookkeeping fields below. So it has every column models/refundRequest/refundRequest.model.js has -- keep the two in
// step. A booking can have several refund requests: every one is archived. The temporary approvalLockedAt lock is
// never copied.
//
// Like the live request, an archive does not store the PayMongo parts / manual hand-back / unrefundable amounts (those
// are the "out" rows of paymentEntries, archived with the booking in paymentEntryArchives) or the customer's own
// userID / reason / notes (those are on the booking's cancellation row, cancellationRequestArchives). The Refund
// Archive page gets them back through hydrateRefundRequestsWithArchives() and the cancellation rows.
// Archives made before the normalization may still carry userID, notes, paymongoRefundID, processedAt,
// amount / grossPaid (old names of toRefundAmount / bookingPaid) and the policyTier / pickupAt snapshot; readers accept both.
// rejectReason is still written on the live request when an OLD document is rejected (see refundRequest.model.js), so a
// new archive can carry it too.
//
// Restore (a refund restore, or restoring its booking) puts the request back in `refundRequests` and deletes this document.
export const RefundArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  refundArchivesID: "",    // Firestore doc ID of this archive document
  originalId: "",          // doc ID of the original 'refundRequests' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",
  customerName: "",        // resolved on read from the cancellation row's userID; not stored on restore

  // ---- copied from the refund request document (see refundRequest.model.js) ----
  refundRequestID: "",
  bookingID: "",
  paymentID: "",
  source: "customer",      // "customer" | "staff"
  outcome: null,           // "refunded" | "already_refunded" | "nothing_owed" -- staff-origin requests only
  toRefundAmount: 0,       // what goes back to the customer
  bookingPaid: 0,          // everything the customer had paid before any forfeit
  returnDeposit: true,
  depositForfeited: 0,
  forfeitWaived: false,
  status: "",              // Pending | Approved | Refunded | Rejected | Failed (at the time of deletion)
  processedBy: null,
  reason: null,            // the STAFF's reason for the decision
  rejectReason: null,      // legacy rejections only: the staff's reason on an OLD document whose `reason` holds the customer's words
  refundedAt: null,
  createdAt: null,
  updatedAt: null,
};