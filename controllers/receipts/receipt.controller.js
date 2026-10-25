import { buildReceipt, buildStatement, emailLimiter, emailKeyFor } from "../../services/receipts/receipt.service.js";
import { sendReceiptEmail, sendStatementEmail } from "../../services/receipts/receiptEmail.service.js";
import { auditSafe } from "../../services/auditLogs/auditLogs.service.js";

const actorUid = (req) => req.user?.userID || req.user?.uid || null;
const publicView = ({ _audit, _email, _ownerID, ...data }) => data;   // never send the real address or internals to the browser

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

    // One shared limit (staff AND the customer's own button): claimed in a transaction BEFORE sending so two quick
    // requests cannot both pass; given back if the send fails.
    const key = emailKeyFor.receipt(receipt.receiptNo);
    const slot = await emailLimiter.claim(key, actorUid(req));
    if (!slot.ok) {
      return res.status(429).json({ success: false, retryAfterSeconds: slot.wait,
        message: `This receipt was just emailed. Please wait ${Math.ceil(slot.wait / 60)} more minute(s) before sending it again.` });
    }

    // Building the email can throw too (not only the send). Treat that like a failed send so the claim is given back.
    let sent;
    try { sent = await sendReceiptEmail({ receipt, toEmail: receipt._email }); }
    catch (err) { sent = { success: false, error: err.message }; }
    if (!sent.success) {
      await emailLimiter.release(key, slot.previous);
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

// GET /api/payment-entries/booking/:bookingID/statement
// Builds the Booking Statement (every payment, every penalty, the totals) as of right now and writes an audit log
// line each time one is printed.
export const getStatement = async (req, res) => {
  try {
    const statement = await buildStatement({ bookingID: req.params.bookingID, printedByUserID: actorUid(req) });
    const data = publicView(statement);

    auditSafe({
      action: "export",
      description: `${data.title} ${data.statementNo} printed for booking ${data.booking.bookingID}.`,
      userID: actorUid(req),
      bookingID: statement._audit.bookingID,
      paymentID: statement._audit.paymentID,
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error("[STATEMENT] build error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/payment-entries/booking/:bookingID/statement/email
// Same rules as the receipt email: only the address on the customer's account (no body, staff cannot choose the
// recipient), one send per statement every 5 minutes, every send written to the audit log.
export const emailStatement = async (req, res) => {
  try {
    const statement = await buildStatement({ bookingID: req.params.bookingID, printedByUserID: actorUid(req) });
    if (!statement._email) {
      return res.status(422).json({ success: false, message: "This customer has no email address on their account." });
    }

    const key = emailKeyFor.statement(statement.booking.bookingID);
    const slot = await emailLimiter.claim(key, actorUid(req));
    if (!slot.ok) {
      return res.status(429).json({ success: false, retryAfterSeconds: slot.wait,
        message: `This statement was just emailed. Please wait ${Math.ceil(slot.wait / 60)} more minute(s) before sending it again.` });
    }

    // Building the email can throw too (not only the send). Treat that like a failed send so the claim is given back.
    let sent;
    try { sent = await sendStatementEmail({ statement, toEmail: statement._email }); }
    catch (err) { sent = { success: false, error: err.message }; }
    if (!sent.success) {
      await emailLimiter.release(key, slot.previous);
      console.error("[STATEMENT] email failed:", sent.error);
      return res.status(502).json({ success: false, message: "Couldn't send the email. Please try again in a bit." });
    }

    auditSafe({
      action: "export",
      description: `${statement.title} ${statement.statementNo} emailed to ${statement.customer.emailMasked} for booking ${statement.booking.bookingID}.`,
      userID: actorUid(req),
      bookingID: statement._audit.bookingID,
      paymentID: statement._audit.paymentID,
    });

    return res.status(200).json({ success: true, message: `Statement emailed to ${statement.customer.emailMasked}.` });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error("[STATEMENT] email error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
