import { db } from "../../config/firebaseConnection/firebase.js";
import generateOTP from "../../utils/otp/generateOTP.js";
import { sendOtpEmail } from "../../services/otp/otp.service.js";

const OTP_EXPIRY_MS   = 5 * 60 * 1000; // 5 minutes
const OTP_COOLDOWN_MS = 60 * 1000;     // 1 minute cooldown between requests
const MAX_ATTEMPTS    = 5;             // max wrong guesses before lockout

// Same shape/collection idea as customer-backend's "otpCodes", kept as its
// own collection ("adminOtpCodes") so admin verification codes never mix
// with customer signup codes, and so an email that happens to exist on
// both sides doesn't share state.
const otpDocFor = (email) => db.collection("adminOtpCodes").doc(email.toLowerCase());

/**
 * POST /api/auth/send-otp
 * (mounted behind verifyToken)
 *
 * Sends a one-time code to the CALLER'S OWN email — always req.user.email
 * from the verified JWT, never an address supplied in the request body.
 * That's what makes this safe to use as a "confirm it's really you"
 * step before a sensitive action (e.g. changing another user's role):
 * an attacker who has stolen a session can't redirect the code anywhere
 * else, and can't OTP-bomb an arbitrary inbox.
 */
export const sendOTP = async (req, res) => {
  const email = req.user?.email;
  if (!email) {
    return res.status(401).json({ success: false, message: "Not authenticated." });
  }

  try {
    const docRef = otpDocFor(email);
    const existing = await docRef.get();

    // Cooldown: block re-sends within 1 minute (same pattern as customer side).
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

    const result = await sendOtpEmail({ toEmail: email, toName: req.user.username, otp });
    if (!result.success) {
      // Code is stored either way — surface the email failure so the UI
      // can tell the admin to contact support instead of silently hanging.
      // "config" (a missing/misscoped env var) gets a message that says so
      // explicitly, since retrying changes nothing until it's fixed on
      // Vercel — unlike a genuine transient EmailJS/network failure.
      return res.status(200).json({
        success: true,
        emailSent: false,
        reason: result.reason,
        message:
          result.reason === "config"
            ? "Verification email is misconfigured on the server (missing EmailJS setting). Retrying won't help — check the Vercel function logs for details."
            : "Could not send the email right now. Please try again in a moment.",
      });
    }

    return res.status(200).json({
      success: true,
      emailSent: true,
      message: "Verification code sent to your email.",
    });
  } catch (error) {
    console.error("[OTP] sendOTP error:", error);
    return res.status(500).json({ success: false, message: "Server error sending verification code." });
  }
};

/**
 * Shared expiry/lockout/match checking, used by both consumeOtp() and
 * peekOtp() below so the two never drift out of sync with each other.
 * consume=true deletes the code on a correct match (single-use, for the
 * moment an action actually fires); consume=false leaves it in place (for
 * "is this even right?" feedback the moment someone finishes typing it,
 * without spending the code before they've actually done anything with it).
 * A wrong guess always counts against the attempt limit either way —
 * that's what stops someone from brute-forcing it through the non-consuming
 * path just because it doesn't burn the code on success.
 */
const checkOtp = async (email, otp, { consume }) => {
  if (!email) return { ok: false, status: 401, message: "Not authenticated." };
  if (!otp)   return { ok: false, status: 400, message: "Verification code is required." };

  const docRef = otpDocFor(email);
  const doc = await docRef.get();

  if (!doc.exists) {
    return { ok: false, status: 400, message: "No verification code found. Please request a new one." };
  }

  const data = doc.data();

  if (new Date() > data.expiresAt.toDate()) {
    await docRef.delete();
    return { ok: false, status: 400, message: "Verification code expired. Please request a new one." };
  }

  if (data.attempts >= MAX_ATTEMPTS) {
    await docRef.delete();
    return { ok: false, status: 429, message: "Too many failed attempts. Please request a new code." };
  }

  if (data.otp !== otp) {
    await docRef.update({ attempts: data.attempts + 1 });
    const remaining = MAX_ATTEMPTS - (data.attempts + 1);
    return {
      ok: false,
      status: 400,
      message: `Invalid code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
    };
  }

  if (consume) await docRef.delete(); // burn it so it can't be reused
  return { ok: true };
};

/**
 * Real, single-use check — for the moment a sensitive action actually
 * fires (currently: updateUserRole, and changeCarStatus's refund batch).
 * NOT an Express handler — call it directly from another controller with
 * the acting admin's email and the code they submitted. Deletes the code
 * on success so it can't be replayed.
 *
 * @returns {{ ok: true } | { ok: false, status: number, message: string }}
 */
export const consumeOtp = (email, otp) => checkOtp(email, otp, { consume: true });

/**
 * "Is this code actually right?" check for the moment someone finishes
 * typing it — real validation (wrong digits / expired / locked out all
 * still apply), but does NOT burn the code, since nothing's actually
 * happening yet. Lets the OTP screen tell staff immediately if they
 * mistyped it, instead of only finding out at the very end after staging
 * every booking. The code is still verified for real via consumeOtp()
 * above at the moment it's actually used — this is a courtesy check, not
 * a replacement for that one.
 *
 * @returns {{ ok: true } | { ok: false, status: number, message: string }}
 */
export const peekOtp = (email, otp) => checkOtp(email, otp, { consume: false });

/**
 * POST /api/auth/check-otp   { otp }
 * (mounted behind verifyToken)
 * Express wrapper around peekOtp() for the OTP screen's own "Continue"
 * button — see peekOtp()'s comment for why this doesn't consume the code.
 */
export const checkOTP = async (req, res) => {
  const result = await peekOtp(req.user?.email, req.body?.otp);
  return res.status(result.ok ? 200 : result.status).json(
    result.ok ? { success: true } : { success: false, message: result.message }
  );
};