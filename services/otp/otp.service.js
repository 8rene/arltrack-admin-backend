import axios from "axios";

// ================================
//  Admin-backend OTP email service
//  Same EmailJS REST approach as services/email/email.service.js
//  (license expiry emails) and customer-backend's otp.controller.js —
//  just a dedicated template for "here is your verification code" instead
//  of a license notice.
//
//  Needs these env vars set in the admin backend's Vercel project:
//    EMAILJS_SERVICE_ID        <- already set, shared with email.service.js
//    EMAILJS_PUBLIC_KEY        <- already set
//    EMAILJS_PRIVATE_KEY       <- already set
//    EMAILJS_OTP_TEMPLATE_ID   <- NEW: separate EmailJS template for OTP codes
// ================================

/**
 * Sends a one-time verification code to an admin/owner's own email.
 * Fire-and-forget shape ({ success, error? }) — the caller decides what to
 * do if sending fails (the code is already stored either way).
 *
 * @param {Object} params
 * @param {string} params.toEmail
 * @param {string} params.toName
 * @param {string} params.otp
 */
export const sendOtpEmail = async ({ toEmail, toName, otp }) => {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_OTP_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email:   toEmail,
      to_name:    toName || toEmail.split("@")[0],
      otp_code:   otp,
      user_email: toEmail,
      app_name:   "ARL Car Rental Admin",
      subject:    "Your ARL Track admin verification code",
      message:    `Your verification code is ${otp}. It expires in 5 minutes and can only be used once. If you didn't request this, you can safely ignore this email.`,
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
    return { success: false, error: detail };
  }
};