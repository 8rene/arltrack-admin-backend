// Matches the 'penaltyArchives' collection in Firestore.
//
// An archive is a COPY of the penalty document, taken when its booking is deleted (see
// services/booking/bookingDelete.service.js), plus the bookkeeping fields below. So it has every column
// models/penalty/penalty.model.js has -- keep the two in step. A booking can have many penalties: every one is archived.
//
// Like the live penalty, an archive does not store paymentMethod / referenceNumber / paidAt: those are paymentEntries
// rows (phase "penalty"), archived with the booking in paymentEntryArchives. The Penalty Archive page gets them back
// through hydratePenaltiesWithArchives() (services/archives/entryArchiveHydrate.service.js). Archives written before the
// normalization may still carry copies of those fields, and confirmedBy / confirmedAt (a penalty is confirmed when
// created, so readers fall back to createdBy / createdAt).
//
// Restore (a penalty restore, or restoring its booking) puts the penalty back in `penalties` and deletes this document.
export const PenaltyArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  penaltyArchivesID: "",   // Firestore doc ID of this archive document
  originalId: "",          // doc ID of the original 'penalties' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",
  customerName: "",        // resolved on read from userID; not stored on restore

  // ---- copied from the penalty document (see penalty.model.js) ----
  penaltyID: "",
  bookingID: "",
  paymentID: "",
  userID: "",
  carID: "",

  lineItems: [],           // [{ description, amount }]

  gatewayFeeRate: null,    // online payment fee % saved when the penalty was created (see penalty.model.js)
  gatewayFeePaid: 0,       // online payment fee the customer has paid on it so far, on top of paidAmount

  computedAmount: 0,
  amount: 0,
  overrideReason: "",

  status: "",              // Confirmed | Voided | Waived (at the time of deletion)
  statusReason: "",
  paidAmount: 0,

  createdBy: null,
  createdAt: null,
  updatedAt: null,
};