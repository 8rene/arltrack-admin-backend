// reviews/{reviewID}   -- the doc ID IS the reviewID, built from the bookingID (reviewIDForBooking in the customer backend), so a
// booking can only be reviewed once
// Written by the CUSTOMER backend. The admin READS reviews (services/reviews/reviews.service.js) and can delete one, which
// copies it into reviewsArchives first (see models/archives/reviewsArchives.model.js). Deleting a booking archives its review too.
export const Review = {
  reviewID: "",      // same as the doc ID (derived from the bookingID)
  userID: "",        // the reviewer (some older rows use reviewerID instead)
  bookingID: "",     // the booking this review is about
  carID: "",         // the car; reviews are grouped and counted per car
  rating: 0,
  comment: "",
  createdAt: null,
  updatedAt: null,
};
