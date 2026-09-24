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
//    EMAILJS_REFUND_TEMPLATE_ID    <- NEW: separate template for the refund email below
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
        ? `Your driver's license on file expired on ${expiryDate}. Please submit an updated license from your profile as soon as possible so an admin can review it.`
        : `Your driver's license on file expires on ${expiryDate} (${daysLeft} day(s) from now). Please submit an updated license from your profile before it expires.`,
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

/**
 * Sends a customer the email counterpart to the "refund_processed" bell
 * notification — currently the only side of this that existed was the bell.
 * Used by staffRefundBooking() (services/refundRequest/refundRequest.service.js)
 * when a car being switched to Maintenance/Inactive forces the cancellation +
 * refund of one of its upcoming bookings. Needs its OWN EmailJS template
 * (EMAILJS_REFUND_TEMPLATE_ID) — not yet configured on Vercel as of writing
 * this, so this will no-op with a "config" reason until that's added.
 *
 * @param {Object} params
 * @param {string} params.toEmail
 * @param {string} params.toName
 * @param {string} params.bookingID
 * @param {number} params.amount        - total refunded (online + manual)
 * @param {number} [params.manualAmount] - portion PayMongo can't return; staff
 *                                         still need to hand this back in person
 * @param {string} params.reason        - the reason staff typed when changing
 *                                         the car's status, shown to the
 *                                         customer so the cancellation isn't
 *                                         a mystery
 */
export const sendRefundEmail = async ({ toEmail, toName, bookingID, amount, manualAmount = 0, reason }) => {
  const missing = ["EMAILJS_SERVICE_ID", "EMAILJS_REFUND_TEMPLATE_ID", "EMAILJS_PUBLIC_KEY", "EMAILJS_PRIVATE_KEY"]
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    const detail = `Missing required env var(s): ${missing.join(", ")}. Add these to the admin backend's Vercel project (Production/Preview/Development each need their own copy) and redeploy.`;
    console.error("❌ Refund email not sent — config problem:", detail);
    return { success: false, reason: "config", error: detail };
  }

  const peso = (n) => `₱${Number(n || 0).toLocaleString()}`;
  const displayName = toName || toEmail.split("@")[0];
  const hasManual = manualAmount > 0;

  const payload = {
    service_id:  process.env.EMAILJS_SERVICE_ID,
    template_id: process.env.EMAILJS_REFUND_TEMPLATE_ID,
    user_id:     process.env.EMAILJS_PUBLIC_KEY,
    accessToken: process.env.EMAILJS_PRIVATE_KEY,
    template_params: {
      to_email:    toEmail,
      to_name:     displayName,
      app_name:    "ARL Car Rental",
      booking_id:  bookingID || "—",
      amount:      peso(amount),
      subject:     `Your booking ${bookingID || ""} was cancelled and refunded`,
      message:
        `Hi ${displayName},\n\n` +
        `Your booking${bookingID ? ` (${bookingID})` : ""} has been cancelled and refunded ${peso(amount)}.\n\n` +
        `Reason: ${reason || "Not specified"}\n\n` +
        (hasManual
          ? `${peso(amount - manualAmount)} has been returned through PayMongo, and ${peso(manualAmount)} will be handed back to you by our staff.\n\n`
          : `This has been returned through PayMongo.\n\n`) +
        `We're sorry for the inconvenience.\n\n` +
        `Best regards,\nARL Car Rental Team`,
      portal_url:  process.env.APP_URL || "http://localhost:3000",
    },
  };

  try {
    await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      payload,
      { headers: { "Content-Type": "application/json" } }
    );
    console.log(`✅ Refund email sent to ${toEmail} for booking ${bookingID}`);
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error("❌ Failed to send refund email:", detail);
    return { success: false, reason: "emailjs", error: detail };
  }
};