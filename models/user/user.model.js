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
  referralCode: null       // this user's own shareable code (ARL-XXXXXXXX); who referred whom lives in "referrals"
};