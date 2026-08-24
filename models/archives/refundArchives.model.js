// Matches the 'refundArchives' collection in Firestore.
// Primary key: refundArchivesId (Firestore document ID)
//
// Unlike transactionLogArchives (which has its own standalone viewer page
// with a manual delete-to-archive button), this archive is only ever
// written as part of deleteBookingWithCascade() in
// services/booking/bookingDelete.service.js — the same way paymentsArchives
// and reviewsArchives get written alongside a booking deletion. There is
// no standalone "delete this one refund request" action anywhere in the
// app to archive from, so no dedicated admin viewer page is planned for
// this collection — it exists purely so a refund request doesn't get
// silently orphaned/lost when its parent booking is deleted.
export const RefundArchive = {
  refundArchivesId: "",   // Firestore doc ID — same as collection name + "Id"
  originalId: "",          // doc ID from original 'refundRequests' collection
  refundRequestID: "",
  bookingID: "",
  paymentID: "",
  userID: "",

  reason: "",
  notes: "",
  amount: 0,
  status: "",              // whatever it was at time of deletion: Pending | Approved | Refunded | Rejected | Failed

  paymongoRefundID: null,
  processedBy: null,
  processedAt: null,
  rejectReason: null,

  createdAt: null,
  updatedAt: null,

  archivedAt: null,
  archivedBy: "",
  // Restore deletes this doc entirely (see restoreRefundArchive in
  // services/archives/refundArchives.service.js) rather than marking it.
  // restoredAt can still show up here though, inherited from the live
  // refund request doc if it's ever archived again after being restored.
  // restoredBy was previously written directly to this doc on restore but
  // that write path no longer exists, so it's been removed from this model.
  restoredAt: null,
};