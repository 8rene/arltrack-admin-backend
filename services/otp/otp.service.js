import axios from "axios";

// ================================
//  Admin-backend OTP email service
//  Same EmailJS REST approach as services/email/email.service.js
//  (license expiry emails) and customer-backend's otp.controller.js —
//  just a dedicated template for "here is your verification code" instead
//  of a license notice.
//
//  Needs these env vars set in the admin backend's Vercel project:
//    EMAILJS_SERVICE_ID    <- already set, shared with email.service.js
//    EMAILJS_PUBLIC_KEY    <- already set
//    EMAILJS_PRIVATE_KEY   <- already set
//    EMAILJS_TEMPLATE_ID   <- NEW: EmailJS template for the OTP email
// ================================

// One-time boot log: reports which of the 4 required vars this running
// deployment can actually see — presence/length only, never the value.
// If EMAILJS_TEMPLATE_ID shows up as "MISSING" here on Vercel while
// the dashboard shows it configured, that's a scope mismatch (the var is
// probably only checked for a different environment — Production vs.
// Preview vs. Development — than the one that's actually running) or a
// deploy that predates when the var was added (Vercel bakes env vars in
// at build/deploy time; adding one afterward needs a redeploy to apply).
const REQUIRED_ENV_VARS = ["EMAILJS_SERVICE_ID", "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY", "EMAILJS_TEMPLATE_ID"];
console.log(
  "[OTP service] EmailJS env var check:",
  REQUIRED_ENV_VARS.map((name) => `${name}=${process.env[name] ? `present (${process.env[name].length} chars)` : "MISSING"}`).join(", ")
);

/**
 * Sends a one-time verification code to an admin/owner's own email.
 * Fire-and-forget shape ({ success, error?, reason? }) — the caller decides
 * what to do if sending fails (the code is already stored either way).
 *
 * @param {Object} params
 * @param {string} params.toEmail
 * @param {string} params.toName
 * @param {string} params.otp
 */
export const sendOtpEmail = async ({ toEmail, toName, otp }) => {
  // Fail loud and specific instead of letting EmailJS reject an
  // undefined/empty field with a generic error that looks identical to a
  // real network hiccup.
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    const detail = `Missing required env var(s): ${missing.join(", ")}. Check they're set for the environment this deployment is running in (Production/Preview/Development each need their own copy on Vercel), and redeploy after adding any of them.`;
    console.error("❌ Admin OTP email not sent — config problem:", detail);
    return { success: false, reason: "config", error: detail };
  }

  const displayName = toName || toEmail.split("@")[0];
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      // Template is a passthrough — just {{subject}} and {{ body }} — so
      // the full email text is assembled here rather than as separate
      // placeholders. Recipient field in the template's "To Email" box is
      // {{email}}, not {{to_email}} — must match exactly or EmailJS sees
      // an empty recipient.
      email:    toEmail,
      subject:  "Your ARLTrack admin verification code",
      body:
        `Hi ${displayName},\n\n` +
        `You're requesting to confirm a role change on your ARLTrack admin account.\n\n` +
        `Your verification code is:\n\n` +
        `${otp}\n\n` +
        `This code expires in 5 minutes and can only be used once.\n\n` +
        `If you did not request this, you can safely ignore this email — no changes will be made without the code.\n\n` +
        `Best regards,\nArlTrack Admin Team`,
    },
  };

  try {
    await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ Admin OTP email sent to ${toEmail}`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Failed to send admin OTP email:", detail);
    return { success: false, reason: "emailjs", error: detail };
  }
};