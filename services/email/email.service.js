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
 * refund of one of its upcoming bookings. A dedicated EmailJS template
 * (EMAILJS_REFUND_TEMPLATE_ID) is optional: if it isn't set, the email goes through
 * the SAME shared general-purpose template the admin OTP email already uses
 * (EMAILJS_TEMPLATE_ID — free EmailJS plans only allow 2 templates).
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
// Shared sender for the refund + cancellation emails.
//   • If `dedicatedTemplateID` is set, that template is used with the named
//     params it expects (to_email / to_name / subject / message / ...).
//   • Otherwise the shared general-purpose template (EMAILJS_TEMPLATE_ID — the
//     same "passthrough" one the admin OTP email uses) is used: its only
//     placeholders are {{subject}} and {{ body }}, and its To field is {{email}}.
// Never throws: returns { success, reason?, error? }.
const sendTransactionalEmail = async ({ label, dedicatedTemplateID, toEmail, toName, subject, text, bookingID, amount }) => {
  const templateID = dedicatedTemplateID || process.env.EMAILJS_TEMPLATE_ID;
  const missing = [["EMAILJS_SERVICE_ID", process.env.EMAILJS_SERVICE_ID], ["EMAILJS_TEMPLATE_ID", templateID], ["EMAILJS_PUBLIC_KEY", process.env.EMAILJS_PUBLIC_KEY], ["EMAILJS_PRIVATE_KEY", process.env.EMAILJS_PRIVATE_KEY]]
    .filter(([, v]) => !v).map(([n]) => n);
  if (missing.length > 0) {
    const detail = `Missing required env var(s): ${missing.join(", ")}. Add these to the admin backend's Vercel project (Production/Preview/Development each need their own copy) and redeploy.`;
    console.error(`❌ ${label} email not sent — config problem:`, detail);
    return { success: false, reason: "config", error: detail };
  }

  const displayName = toName || toEmail.split("@")[0];
  const templateParams = dedicatedTemplateID
    ? {
        to_email: toEmail, to_name: displayName, app_name: "ARL Car Rental",
        booking_id: bookingID || "—", amount, subject, message: text,
        portal_url: process.env.APP_URL || "http://localhost:3000",
      }
    : {
        // Same recipient aliases the customer backend sends, so it resolves
        // whichever variable the template's "To Email" box is bound to.
        email: toEmail, to_email: toEmail, user_email: toEmail, recipient_email: toEmail,
        subject, body: text,
      };

  try {
    await axios.post(
      "https://api.emailjs.com/api/v1.0/email/send",
      {
        service_id:  process.env.EMAILJS_SERVICE_ID,
        template_id: templateID,
        user_id:     process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: templateParams,
      },
      { headers: { "Content-Type": "application/json" } }
    );
    return { success: true };
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Failed to send ${label} email:`, detail);
    return { success: false, reason: "emailjs", error: detail };
  }
};

export const sendRefundEmail = async ({ toEmail, toName, bookingID, amount, manualAmount = 0, depositForfeited = 0, reason }) => {
  const peso = (n) => `₱${Number(n || 0).toLocaleString()}`;
  const displayName = toName || toEmail.split("@")[0];
  const hasManual = manualAmount > 0;
  return sendTransactionalEmail({
    label: "Refund",
    dedicatedTemplateID: process.env.EMAILJS_REFUND_TEMPLATE_ID,
    toEmail, toName, bookingID, amount: peso(amount),
    subject: `Your booking ${bookingID || ""} was cancelled — refund approved`,
    text:
      `Hi ${displayName},\n\n` +
      `Your booking${bookingID ? ` (${bookingID})` : ""} has been cancelled and a refund of ${peso(amount)} has been approved.\n\n` +
      `Reason: ${reason || "Not specified"}\n\n` +
      (hasManual
        ? `${peso(amount - manualAmount)} will be returned through PayMongo, and ${peso(manualAmount)} will be handed back to you by our staff.\n\n`
        : `It will be returned through PayMongo.\n\n`) +
      `Please allow up to 24 hours for the refund to be processed. We'll notify you once it has been returned.\n\n` +
      (depositForfeited > 0
        ? `As our cancellation policy states, your ${peso(depositForfeited)} deposit is non-refundable and has been kept.\n\n`
        : "") +
      `We're sorry for the inconvenience.\n\n` +
      `Best regards,\nARL Car Rental Team`,
  });
};

// Sent when staff cancel a booking and NO money is being returned (cancel-only,
// or nothing had been paid). Uses EMAILJS_CANCEL_TEMPLATE_ID or
// EMAILJS_REFUND_TEMPLATE_ID if either is set, else the shared template.
export const sendCancellationEmail = async ({ toEmail, toName, bookingID, reason, refundNote = "" }) => {
  const displayName = toName || toEmail.split("@")[0];
  return sendTransactionalEmail({
    label: "Cancellation",
    dedicatedTemplateID: process.env.EMAILJS_CANCEL_TEMPLATE_ID || process.env.EMAILJS_REFUND_TEMPLATE_ID,
    toEmail, toName, bookingID, amount: "No refund",
    subject: `Your booking ${bookingID || ""} was cancelled`,
    text:
      `Hi ${displayName},\n\n` +
      `Your booking${bookingID ? ` (${bookingID})` : ""} has been cancelled.\n\n` +
      `Reason: ${reason || "Not specified"}\n\n` +
      (refundNote ? `${refundNote}\n\n` : "") +
      `If you have questions, please contact us.\n\n` +
      `Best regards,\nARL Car Rental Team`,
  });
};