import crypto from "crypto";
import { db } from "../../config/firebaseConnection/firebase.js";

// Same format + alphabet as the customer backend's utils/referrals/referral.util.js
// so codes made here look and behave exactly like customer codes
// (ARL- + 8 chars, no look-alike characters).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH   = 8;
const CODE_PREFIX   = "ARL-";

const randomCode = () => {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${CODE_PREFIX}${out}`;
};

// Makes a code no other user already has (checked against user.referralCode).
export const generateUniqueReferralCode = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCode();
    const snap = await db.collection("user").where("referralCode", "==", candidate).limit(1).get();
    if (snap.empty) return candidate;
  }
  throw new Error("Could not generate a unique referral code.");
};