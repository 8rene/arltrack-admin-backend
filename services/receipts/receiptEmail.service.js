// Emails ONE receipt (the object built by receipt.service.js) to the customer.
//   - the receipt is written INTO the email body (inline styles; no PDF, nothing is stored or made public)
//   - sent through the same shared EmailJS "general purpose" template the customer backend uses, so it needs the
//     same four settings in THIS backend's .env: EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY,
//     EMAILJS_PRIVATE_KEY. (Node 18+ built-in fetch; no extra package.)

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => `₱${(Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "—"; };
const day = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" }) : null; };
const METHOD = { gcash: "GCash", maya: "Maya", qrph: "QR Ph", cash: "Cash", bank_transfer: "Bank transfer" };

const row = (label, value) => (value == null || value === "" ? "" : `
  <tr><td style="padding:3px 0;color:#6b7280;font-size:13px;">${esc(label)}</td><td style="padding:3px 0;text-align:right;font-size:13px;color:#111827;">${esc(value)}</td></tr>`);
const rule = `<tr><td colspan="2" style="padding:6px 0;"><div style="border-top:1px dashed #d1d5db;"></div></td></tr>`;

export const renderReceiptEmail = (r) => {
  const out = r.direction === "out";
  const period = day(r.booking?.startDateTime) ? `${day(r.booking.startDateTime)} – ${day(r.booking.endDateTime) || "—"}` : null;
  const lines = r.lines.map((l) => `
  <tr><td style="padding:3px 0;font-size:14px;color:#1f2937;">${esc(l.label)}</td><td style="padding:3px 0;text-align:right;font-size:14px;font-weight:bold;color:#111827;">${peso(l.amount)}</td></tr>`).join("");
  const summary = r.summary ? `${rule}${row("Booking total", peso(r.summary.bookingTotal))}${row("Paid to date", peso(r.summary.paidToDate))}${row("Balance remaining", peso(r.summary.balanceAfter))}` : "";

  const bodyHtml = `
  <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1f2937;">
    <h2 style="color:#1e3a8a;margin:0 0 4px;text-align:center;">${esc(r.business.name)}</h2>
    ${r.business.address ? `<p style="margin:0;text-align:center;font-size:12px;color:#6b7280;">${esc(r.business.address)}</p>` : ""}
    ${r.business.phone || r.business.email ? `<p style="margin:0;text-align:center;font-size:12px;color:#6b7280;">${esc([r.business.phone, r.business.email].filter(Boolean).join(" · "))}</p>` : ""}
    <p style="margin:12px 0 4px;text-align:center;font-size:14px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#374151;">${esc(r.title)}${r.isCopy ? " (copy)" : ""}</p>
    <p style="margin:0 0 12px;text-align:center;font-size:14px;">Hi ${esc(r.customer.name && r.customer.name !== "—" ? r.customer.name : "Valued Customer")}, here is your ${out ? "slip" : "receipt"}.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rule}
      ${row("Receipt no.", r.receiptNo)}${row("Date", when(r.date))}${row(out ? "Paid to" : "Received from", r.customer.name)}
      ${row("Booking", r.booking?.bookingID)}${row("Vehicle", r.booking?.vehicle)}${row("Rental period", period)}
      ${rule}
      ${lines}
      <tr><td style="padding:8px 0 3px;border-top:1px solid #d1d5db;font-size:14px;font-weight:bold;">${out ? "Total returned" : "Total received"}</td><td style="padding:8px 0 3px;border-top:1px solid #d1d5db;text-align:right;font-size:16px;font-weight:bold;">${peso(r.total)}</td></tr>
      ${rule}
      ${row("Method", METHOD[r.method] || r.method)}${row("Channel", r.source === "in_person" ? "In person" : "Online (PayMongo)")}
      ${row("Reference no.", r.referenceNumber)}${row(out ? "Handed back by" : "Received by", r.handledBy)}
      ${summary}
    </table>
    <p style="margin-top:24px;font-size:12px;color:#6b7280;">This is a system-generated acknowledgment of the transaction above. Please don't reply directly to this email.</p>
  </div>`;

  return { subject: `${r.title} ${r.receiptNo}${r.booking?.bookingID ? ` — Booking ${r.booking.bookingID}` : ""}`, bodyHtml };
};

export const sendReceiptEmail = async ({ receipt, toEmail }) => {
  const { subject, bodyHtml } = renderReceiptEmail(receipt);
  const { EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY } = process.env;
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    return { success: false, error: "Email is not configured on the server (EMAILJS_* settings are missing)." };
  }
  try {
    const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: EMAILJS_SERVICE_ID, template_id: EMAILJS_TEMPLATE_ID, user_id: EMAILJS_PUBLIC_KEY, accessToken: EMAILJS_PRIVATE_KEY,
        // the shared template is addressed through whichever of these it uses, same as the customer backend
        template_params: { to_email: toEmail, email: toEmail, user_email: toEmail, recipient_email: toEmail, subject, body: bodyHtml },
      }),
    });
    if (!res.ok) return { success: false, error: `Email service answered ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
};