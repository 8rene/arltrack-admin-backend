// Matches the 'reviewsArchives' collection in Firestore
// Primary key: reviewsArchivesID (Firestore document ID)
//
// Written from two places with the same shape: archiveReview() in
// services/booking/bookingDelete.service.js (cascade, when a booking is
// deleted) and archiveAndDeleteReview() in services/reviews/reviews.service.js
// (standalone, when a review is deleted directly from the admin Reviews page).
//
// NOTE: restore deletes this document entirely (see restoreReviewsArchive in
// services/archives/reviewsArchives.service.js) rather than marking it
// restoredAt/restoredBy — a restored review's history lives in the audit
// log instead.
//
// Restoring writes no restore stamp (restoredAt/restoredBy) onto the live
// review doc either, so a re-archived review carries none.
export const ReviewsArchive = {
  reviewsArchivesID: "", // Firestore doc ID — same as collection name + "ID"
  reviewID: "",          // doc ID from original 'reviews' collection
  originalId: "",        // same value as reviewID — kept for consistency with other archive models
  userID: "",            // reviewer's user ID (some older rows may instead have reviewerID)
  reviewerID: "",
  bookingID: "",
  carID: "",
  rating: 0,
  comment: "",
  createdAt: null,
  updatedAt: null,
  archiveDate: null,
  archivedAt: null,
  archivedBy: "",
};