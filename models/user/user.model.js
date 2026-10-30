export const User = {
  createdAt: null,
  email: "",
  isVerified: false,
  phone: "",
  profileImage: "",
  roleID: "",
  userID: "",
  username: "",
  updatedAt: null,         // last profile/status change (customer: avatar + username edits; admin: status / isFlagged edits)
  // Account state. The customer backend creates every account "locked", not verified and not flagged; staff unlock/verify
  // and flag it from the admin app (user.controller.js updateUserAccount: writes status + isFlagged).
  status: "locked",        // "active" | "inactive" | "locked" -- new accounts start "locked"; unlocking sets "active". "inactive" and "locked" are both blocked at login
  isFlagged: false,
  // Referral (written by the customer backend at signup)
  referralCode: null,      // this user's own shareable code (ARL-XXXXXXXX); who referred whom lives in "referrals"
  // Terms & Conditions accepted at signup (written by the customer backend; termsVersionID -> termsVersions/{id})
  termsVersionID: null,
  termsAcceptedAt: null
};