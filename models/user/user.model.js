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
  status: "locked",        // "locked" | "unlocked"
  isFlagged: false,
  // Referral (written by the customer backend at signup)
  referralCode: null,      // this user's own shareable code (ARL-XXXXXXXX); who referred whom lives in "referrals"
  // Terms & Conditions accepted at signup (written by the customer backend; termsVersionID -> termsVersions/{id})
  termsVersionID: null,
  termsAcceptedAt: null,
  // Account merge. Written by the admin app (mergeUserArchive in userArchives.service.js) onto the SURVIVING account when
  // an archived account is merged into it. Present only on an account that has had at least one merge.
  mergedFromUserIDs: [],   // userIDs of the old (archived) accounts whose data was moved here; arrayUnion, so it grows per merge
  mergedAt: null,          // Firestore server timestamp of the latest merge
  mergedBy: ""             // uid of the admin who ran the latest merge
};