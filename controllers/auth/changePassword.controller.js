import admin from "firebase-admin";
import { consumeOtp } from "../otp/otp.controller.js";

// ================================================================
// Logged-in "change my own password" flow, from Account settings.
// Different from passwordReset.controller.js (that one is for staff who
// CAN'T log in at all, and isn't behind verifyToken). This one is for a
// staff member who's already signed in and just wants to set a new
// password, gated by the same "prove it's really you" OTP mechanic
// already used for role changes (user.controller.js updateUserRole) and
// the refund batch (fleet.controller.js) — a fresh code sent to the
// caller's OWN email via POST /api/auth/send-otp, then consumed here.
// ================================================================

// Same strength rule enforced everywhere else a password gets set
// (passwordReset.controller.js and admin staff-account creation) — kept
// identical so a password that's valid in one place is valid everywhere.
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+[\]{};':"\\|,.<>/?]).{8,16}$/;

// PATCH /api/auth/change-password
// (mounted behind verifyToken)
// body: { otp, newPassword }
export const changePassword = async (req, res) => {
  try {
    const { otp, newPassword } = req.body;

    if (!otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Verification code and new password are required.",
      });
    }

    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be 8–16 characters with at least 1 uppercase, 1 lowercase, 1 number, and 1 special character.",
      });
    }

    // Real, single-use check — burns the code so it can't be replayed.
    // Sent via POST /api/auth/send-otp { purpose: "change-password" } to
    // req.user.email, so this can never be redirected to another inbox.
    const verification = await consumeOtp(req.user.email, otp);
    if (!verification.ok) {
      return res.status(verification.status).json({ success: false, message: verification.message });
    }

    await admin.auth().updateUser(req.user.uid, { password: newPassword });

    // Firebase automatically revokes this account's existing refresh
    // tokens once the password changes, so the Firebase client SDK session
    // this browser is holding (used for Firestore reads/listeners
    // throughout the app) will stop refreshing shortly. The app's own
    // session JWT (verifyToken) is separate and stays valid until its own
    // expiry, but the frontend should still sign the user out right after
    // this succeeds and send them back to the login screen, so both sides
    // of "signed in" line back up with the new password immediately.
    return res.status(200).json({
      success: true,
      message: "Password changed successfully. Please log in again with your new password.",
    });
  } catch (error) {
    console.error("[AUTH] changePassword error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error changing password. Please try again.",
    });
  }
};