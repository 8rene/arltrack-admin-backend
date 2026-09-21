export const User = {
  createdAt: null,
  email: "",
  isVerified: false,
  phone: "",
  profileImage: "",
  roleID: "",
  userID: "",
  username: "",
  // Referral (written by the customer backend at signup)
  referralCode: null,      // this user's own shareable code (ARL-XXXXXXXX)
  referredBy: null,        // userID of whoever referred them
  referredByCode: null,    // code they typed at signup (kept even if it matched nobody)
  referralCount: 0         // how many people they've referred
};