// Matches the 'penaltyArchives' collection in Firestore.
// Primary key: penaltyArchivesId (Firestore document ID)
//
// Written from deleteBookingWithCascade() in
// services/booking/bookingDelete.service.js — a booking can have many
// penalties, so every one of them is archived alongside the booking (same
// pattern as refundArchives). Before this, deleting a booking left its
// penalties live in `penalties`, pointing at a booking/payment that no
// longer existed.
//
// Restore (services/archives/penaltyArchives.service.js) puts the penalty
// back in `penalties` and, if the booking/payment were archived with it,
// brings those back too. Restore deletes this doc rather than marking it.
export const PenaltyArchive = {
  penaltyArchivesId: "",  // Firestore doc ID
  originalId: "",          // doc ID from original 'penalties' collection
  penaltyID: "",
  bookingID: "",
  paymentID: "",
  userID: "",
  carID: "",

  lineItems: [],           // [{ description, amount }]
  computedAmount: 0,
  amount: 0,
  overrideReason: "",

  status: "",              // Confirmed | Voided | Waived (at time of deletion)
  statusReason: "",
  paymentMethod: "",
  referenceNumber: "",
  paidAmount: 0,
  paidAt: null,

  createdBy: null,
  confirmedBy: null,
  confirmedAt: null,
  createdAt: null,
  updatedAt: null,

  archivedAt: null,
  archivedBy: "",
  restoredAt: null,        // only present if it was restored, then archived again
};