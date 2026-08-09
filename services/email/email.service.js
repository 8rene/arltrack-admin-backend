import axios from "axios";

// ================================
//  Admin-backend email service
//  Same EmailJS REST approach as customer-backend/services/email.service.js
//  (that one isn't touched here — this is a separate copy on the admin side,
//  since we're not editing the customer repo). Uses its own template so the
//  copy can be staff-specific ("your license is expiring") rather than
//  customer-specific.
//
//  Needs these env vars set in the admin backend's Vercel project:
//    EMAILJS_SERVICE_ID
//    EMAILJS_LICENSE_TEMPLATE_ID   <- separate template from any customer one
//    EMAILJS_PUBLIC_KEY
//    EMAILJS_PRIVATE_KEY
// ================================

/**
 * Sends a driver's-license expiry notice (warning or already-expired) to a
 * Driver/Supervisor. Fire-and-forget from the caller's side — this returns
 * a { success, error? } shape rather than throwing, so one failed email
 * never breaks the rest of the nightly scan.
 *
 * @param {Object} params
 * @param {string} params.toEmail
 * @param {string} params.toName
 * @param {boolean} params.isExpired   - true = already expired, false = expiring soon
 * @param {number} params.daysLeft     - only meaningful when isExpired is false
 * @param {string} params.expiryDate   - human-readable date string for the email body
 */
export const sendLicenseExpiryEmail = async ({ toEmail, toName, isExpired, daysLeft, expiryDate }) => {
  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_LICENSE_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email:     toEmail,
      to_name:      toName || "Team Member",
      app_name:     "ARL Car Rental",
      status:       isExpired ? "expired" : "expiring soon",
      days_left:    isExpired ? 0 : daysLeft,
      expiry_date:  expiryDate,
      subject:      isExpired
        ? "Your driver's license has expired"
        : `Your driver's license expires in ${daysLeft} day(s)`,
      message:      isExpired
        ? `Your driver's license on file expired on ${expiryDate}. Your account has been locked until an updated license is submitted and reviewed.`
        : `Your driver's license on file expires on ${expiryDate} (${daysLeft} day(s) from now). Please submit an updated license from your profile before it expires to avoid your account being locked.`,
      portal_url:   process.env.APP_URL || "http://localhost:3000",
    },
  };

  try {
    await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ License ${isExpired ? "expired" : "expiring"} email sent to ${toEmail}`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Failed to send license expiry email:", detail);
    return { success: false, error: detail };
  }
};