import { buildReceipt, emailCooldownLeft } from "../../services/receipts/receipt.service.js";
import { sendReceiptEmail } from "../../services/receipts/receiptEmail.service.js";
import { auditSafe } from "../../services/auditLogs/auditLogs.service.js";

const actorUid = (req) => req.user?.userID || req.user?.uid || null;
const publicView = ({ _audit, _email, ...data }) => data;   // never send the real address or internals to the browser

// GET /api/payment-entries/:entryID/receipt
// Builds the receipt for one successful money movement and writes an audit log line each time one is printed,
// so a reprint is traceable (and shows as a COPY).
export const getReceipt = async (req, res) => {
  try {
    const receipt = await buildReceipt({ entryID: req.params.entryID, printedByUserID: actorUid(req) });
    const data = publicView(receipt);

    auditSafe({
      action: "export",
      description: `${data.isCopy ? "Copy of " : ""}${data.title} ${data.receiptNo} printed${data.booking.bookingID ? ` for booking ${data.booking.bookingID}` : ""}.`,
      userID: actorUid(req),
      bookingID: receipt._audit.bookingID,
      paymentID: receipt._audit.paymentID,
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error("[RECEIPT] build error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/payment-entries/:entryID/receipt/email
// Emails the receipt to the address on the customer's account -- never to an address typed by staff (the request
// has no body on purpose). One send per receipt every 5 minutes; every send is written to the audit log.
export const emailReceipt = async (req, res) => {
  try {
    const receipt = await buildReceipt({ entryID: req.params.entryID, printedByUserID: actorUid(req) });
    if (!receipt._email) {
      return res.status(422).json({ success: false, message: "This customer has no email address on their account." });
    }

    const wait = await emailCooldownLeft({ paymentID: receipt._audit.paymentID, receiptNo: receipt.receiptNo });
    if (wait > 0) {
      return res.status(429).json({ success: false, retryAfterSeconds: wait,
        message: `This receipt was just emailed. Please wait ${Math.ceil(wait / 60)} more minute(s) before sending it again.` });
    }

    const sent = await sendReceiptEmail({ receipt, toEmail: receipt._email });
    if (!sent.success) {
      console.error("[RECEIPT] email failed:", sent.error);
      return res.status(502).json({ success: false, message: "Couldn't send the email. Please try again in a bit." });
    }

    auditSafe({
      action: "export",
      description: `${receipt.title} ${receipt.receiptNo} emailed to ${receipt.customer.emailMasked}${receipt.booking.bookingID ? ` for booking ${receipt.booking.bookingID}` : ""}.`,
      userID: actorUid(req),
      bookingID: receipt._audit.bookingID,
      paymentID: receipt._audit.paymentID,
    });

    return res.status(200).json({ success: true, message: `Receipt emailed to ${receipt.customer.emailMasked}.` });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error("[RECEIPT] email error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};