import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import generateOTP from "../../utils/otp/generateOTP.js";
import { sendOtpEmail } from "../../services/otp/otp.service.js";

// ================================================================
// Admin-side "forgot password" flow — the counterpart to the OTP flow in
// controllers/otp/otp.controller.js, but for someone who ISN'T logged in
// yet (that one requires verifyToken and always emails req.user's own
// address; this one is exactly for the case where you can't log in at all).
//
// Deliberately its own collection ("adminPasswordResetOtp") rather than
// reusing "adminOtpCodes" — that collection's whole design assumes a
// logged-in caller confirming their own email from the JWT, and mixing an
// unauthenticated flow into it would be easy to get wrong later.
//
// customer-backend's forgot-password flow (controllers/auth/otp.controller.js
// + resetPassword.controller.js) explicitly BLOCKS Owner/Admin/Supervisor/
// Driver accounts, on purpose, so staff can't reset their password through
// the customer-facing site. This is the flow that's supposed to exist
// instead for those same accounts — same OTP mechanics, just scoped to
// staffUser instead of excluding it.
// ================================================================

const OTP_EXPIRY_MS   = 5 * 60 * 1000; // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000;     // 1 minute cooldown between requests
const MAX_ATTEMPTS    = 5;             // max wrong guesses before lockout

// Same strength rule enforced on the customer side (resetPassword.controller.js)
// and at admin staff-account creation — kept identical so a password that's
// valid in one place is valid everywhere.
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+[\]{};':"\\|,.<>/?]).{8,16}$/;

const otpDocFor = (email) => db.collection("adminPasswordResetOtp").doc(email.toLowerCase());

// A email only counts as "resettable" here if it's a real Firebase Auth
// user AND has a matching staffUser record — mirrors exactly what login()
// in auth.controller.js checks (email → staffUser → userID → user doc).
// Returns null if any link in that chain is missing.
const resolveStaffAccount = async (email) => {
  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code === "auth/user-not-found") return null;
    throw err;
  }

  const staffSnap = await db.collection("staffUser").where("email", "==", email).get();
  if (staffSnap.empty) return null;

  const userID = staffSnap.docs[0].data().userID;
  if (!userID) return null;

  const userSnap = await db.collection("user").doc(userID).get();
  if (!userSnap.exists) return null;

  return { firebaseUser, userData: userSnap.data() };
};

// POST /api/auth/forgot-password/send-otp
// body: { email }
// No verifyToken — this is exactly the "I can't log in" case. Message is
// intentionally generic ("No account found with this email") whether the
// email doesn't exist at all, belongs to a customer instead of staff, or
// belongs to staff but is missing a linked record somewhere — never
// reveals which, same reasoning as login()'s error messages already use.
export const sendPasswordResetOTP = async (req, res) => {
  const { email: rawEmail } = req.body;
  if (!rawEmail) {
    return res.status(400).json({ success: false, message: "Email is required." });
  }
  const email = rawEmail.trim().toLowerCase();

  try {
    const account = await resolveStaffAccount(email);
    if (!account) {
      return res.status(404).json({ success: false, message: "No account found with this email." });
    }

    const docRef = otpDocFor(email);
    const existing = await docRef.get();
    if (existing.exists) {
      const createdAt = existing.data().createdAt?.toDate?.() || new Date(0);
      const elapsed = Date.now() - createdAt.getTime();
      if (elapsed < OTP_COOLDOWN_MS) {
        const secondsLeft = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${secondsLeft} second${secondsLeft === 1 ? "" : "s"} before requesting a new code.`,
        });
      }
    }

    const otp = generateOTP();
    await docRef.set({
      otp,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MS),
      attempts: 0,
    });

    const result = await sendOtpEmail({
      toEmail: email,
      toName: account.userData?.username,
      otp,
      purpose: "password-reset",
    });

    if (!result.success) {
      return res.status(200).json({
        success: true,
        emailSent: false,
        reason: result.reason,
        message:
          result.reason === "config"
            ? "Verification email is misconfigured on the server. Please contact support."
            : "Could not send the email right now. Please try again in a moment.",
      });
    }

    return res.status(200).json({ success: true, emailSent: true, message: "Verification code sent to your email." });
  } catch (error) {
    console.error("[AUTH] sendPasswordResetOTP error:", error);
    return res.status(500).json({ success: false, message: "Server error sending verification code." });
  }
};

// POST /api/auth/forgot-password/reset
// body: { email, otp, newPassword }
export const resetAdminPassword = async (req, res) => {
  const { email: rawEmail, otp, newPassword } = req.body;
  if (!rawEmail || !otp || !newPassword) {
    return res.status(400).json({ success: false, message: "Email, code, and new password are required." });
  }
  const email = rawEmail.trim().toLowerCase();

  if (!PASSWORD_REGEX.test(newPassword)) {
    return res.status(400).json({
      success: false,
      message: "Password must be 8–16 characters with at least 1 uppercase, 1 lowercase, 1 number, and 1 special character.",
    });
  }

  try {
    const otpRef = otpDocFor(email);
    const otpDoc = await otpRef.get();

    if (!otpDoc.exists) {
      return res.status(404).json({ success: false, message: "Code not found. Please request a new one." });
    }

    const otpData = otpDoc.data();

    if (new Date() > otpData.expiresAt.toDate()) {
      await otpRef.delete();
      return res.status(400).json({ success: false, message: "Code has expired. Please request a new one." });
    }

    if (otpData.attempts >= MAX_ATTEMPTS) {
      await otpRef.delete();
      return res.status(429).json({ success: false, message: "Too many failed attempts. Please request a new code." });
    }

    if (otpData.otp !== otp) {
      await otpRef.update({ attempts: otpData.attempts + 1 });
      const remaining = MAX_ATTEMPTS - (otpData.attempts + 1);
      return res.status(400).json({
        success: false,
        message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      });
    }

    // Code correct — re-verify this is still a real, linked staff account
    // (not just trusted from send-otp) before touching the password, same
    // defense-in-depth reasoning as customer-backend's resetPassword.controller.js.
    const account = await resolveStaffAccount(email);
    if (!account) {
      await otpRef.delete();
      return res.status(404).json({ success: false, message: "No account found with this email." });
    }

    await admin.auth().updateUser(account.firebaseUser.uid, { password: newPassword });

    // Single-use — delete now that it's been consumed.
    await otpRef.delete();

    return res.status(200).json({ success: true, message: "Password reset successfully. You can now log in with your new password." });
  } catch (error) {
    console.error("[AUTH] resetAdminPassword error:", error);
    return res.status(500).json({ success: false, message: "Server error resetting password. Please try again." });
  }
};