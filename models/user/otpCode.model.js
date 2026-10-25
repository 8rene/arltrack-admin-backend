// otpCodes/{email}
// One-time codes, SHARED with the customer backend. There is at most one document per email, and the document ID is the
// email in lower case (it is not stored as a field). Saving a new code overwrites the old one.
//   admin backend writes: controllers/otp/otp.controller.js ("admin-action") and
//                         controllers/auth/passwordReset.controller.js ("admin-reset")
//   customer backend uses: "signup" and "reset"
// The purpose is what stops a code from one flow being accepted by another.
export const OtpCode = {
  otp: "",           // the code
  purpose: "",       // "admin-action" | "admin-reset" (admin backend) | "signup" | "reset" (customer backend)
  createdAt: null,
  expiresAt: null,   // Firestore Timestamp; an expired code is deleted when it is checked
  attempts: 0,       // wrong tries so far; the code is deleted once the limit is reached
  // A correct code is deleted when it is consumed, so it cannot be used twice.
};
