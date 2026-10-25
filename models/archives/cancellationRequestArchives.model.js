// Matches the 'cancellationRequestArchives' collection in Firestore.
//
// An archive is a COPY of every cancellationRequests row of a booking (customer requests in any status AND the
// direct cancellation row), taken when the booking is deleted (see services/booking/bookingDelete.service.js and
// services/archives/linkedArchives.service.js), plus the bookkeeping fields below. So it has every column
// models/cancellationRequests/cancellationRequest.model.js has -- keep the two in step.
//
// The archive document id IS the live cancellationRequestID. That matters: a direct cancellation row is keyed by
// its booking, and a restore must put it back under the same key. Restore moves the row back and deletes this
// document; the live row gets no restoredAt (the live model has no such column).
export const CancellationRequestArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  cancellationRequestArchivesID: "",  // Firestore doc ID of this archive document (= the live document's ID)
  // originalId is NOT stored any more: this archive document's ID IS the live document's ID (restore writes it back under that ID).
  // The archive list APIs still return it as originalId (= the document ID) so the pages keep working.
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",

  // ---- copied from the cancellationRequests document (see cancellationRequest.model.js) ----
  cancellationRequestID: "",
  bookingID: "",
  userID: "",
  reason: "",
  refundRequestID: null,   // set on a row that belongs to a refund request
  notes: "",
  status: "",              // "pending" | "approved" | "rejected" (direct rows carry none)
  createdAt: null,         // old rows carry requestedAt instead
  updatedAt: null,
  processedBy: null,
  processedAt: null,
  rejectReason: null,
  cancelledBy: null,       // direct rows only: customer | staff | admin | system | refund | unknown
};