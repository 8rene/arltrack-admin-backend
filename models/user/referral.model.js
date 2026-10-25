// referrals/{referralID}
// "Who invited whom". Written by the CUSTOMER backend at signup; the admin only READS it (controllers/user/user.controller.js
// adds referral info to the users list). When an archived account is merged into a new one, userArchives.service.js re-points
// both fields from the old uid to the new uid.
export const Referral = {
  referralID: "",       // this row's own random ID, stored as a field (nothing is ever looked up by it)
  referrerUserID: "",   // the user who invited
  referredUserID: "",   // the user who signed up with the code
  createdAt: null,
};
