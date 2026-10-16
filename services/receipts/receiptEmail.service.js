// Emails ONE receipt (the object built by receipt.service.js) to the customer.
//   - the receipt is written INTO the email body (inline styles; no PDF, nothing is stored or made public)
//   - sent through the same shared EmailJS "general purpose" template the customer backend uses, so it needs the
//     same four settings in THIS backend's .env: EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY,
//     EMAILJS_PRIVATE_KEY. (Node 18+ built-in fetch; no extra package.)

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const peso = (n) => `₱${(Number(n) || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const when = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }) : "—"; };
export const day = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" }) : null; };
export const METHOD = { gcash: "GCash", maya: "Maya", qrph: "QR Ph", cash: "Cash", bank_transfer: "Bank transfer" };

export const BRAND = "#1e3a8a";
export const FONT = "font-family:Arial,Helvetica,sans-serif;";

// one label / value line of the details block
export const row = (label, value, strong = false) => (value == null || value === "" ? "" : `
        <tr>
          <td style="${FONT}padding:11px 0;border-bottom:1px solid #eef0f3;font-size:14px;color:#6b7280;width:42%;vertical-align:top;">${esc(label)}</td>
          <td style="${FONT}padding:11px 0;border-bottom:1px solid #eef0f3;font-size:14px;color:#111827;text-align:right;vertical-align:top;word-break:break-word;${strong ? "font-weight:bold;" : ""}">${esc(value)}</td>
        </tr>`);

export const sectionTitle = (text) => `
        <tr><td colspan="2" style="${FONT}padding:22px 0 4px;font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND};">${esc(text)}</td></tr>`;


// small grey box used for the extra sections (penalty charges, deposit use, a note)
export const box = (inner) => `
        <div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;">
          <tr><td style="padding:14px 20px;">${inner}</td></tr>
        </table>`;
export const pair = (label, value, strong = false) => `
            <tr>
              <td style="${FONT}padding:4px 0;font-size:14px;color:${strong ? "#111827" : "#475569"};${strong ? "font-weight:bold;" : ""}">${esc(label)}</td>
              <td style="${FONT}padding:4px 0 4px 16px;font-size:14px;color:#111827;text-align:right;white-space:nowrap;${strong ? "font-weight:bold;" : ""}">${value}</td>
            </tr>`;
export const spacer = (px) => `<div style="height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</div>`;
export const boxTitle = (text) => `<div style="${FONT}font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND};padding-bottom:6px;">${esc(text)}</div>`;

export const renderReceiptEmail = (r) => {
  const out = r.direction === "out";
  const period = day(r.booking?.startDateTime) ? `${day(r.booking.startDateTime)} – ${day(r.booking.endDateTime) || "—"}` : null;
  const customer = r.customer.name && r.customer.name !== "—" ? r.customer.name : "Valued Customer";

  const lines = r.lines.map((l) => `
          <tr>
            <td style="${FONT}padding:9px 0;font-size:15px;color:#1f2937;vertical-align:top;">${esc(l.label)}</td>
            <td style="${FONT}padding:9px 0 9px 16px;font-size:15px;font-weight:bold;color:#111827;text-align:right;white-space:nowrap;vertical-align:top;">${peso(l.amount)}</td>
          </tr>`).join("");

  const summary = r.summary ? `
      ${spacer(20)}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eff6ff;border-radius:10px;">
        <tr><td style="padding:16px 20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="${FONT}padding:4px 0;font-size:14px;color:#475569;">Booking total</td><td style="${FONT}padding:4px 0;font-size:14px;color:#111827;text-align:right;">${peso(r.summary.bookingTotal)}</td></tr>
            <tr><td style="${FONT}padding:4px 0;font-size:14px;color:#475569;">Paid to date</td><td style="${FONT}padding:4px 0;font-size:14px;color:#111827;text-align:right;">${peso(r.summary.paidToDate)}</td></tr>
            <tr><td style="${FONT}padding:10px 0 2px;border-top:1px solid #bfdbfe;font-size:15px;font-weight:bold;color:${BRAND};">Balance remaining</td><td style="${FONT}padding:10px 0 2px;border-top:1px solid #bfdbfe;font-size:15px;font-weight:bold;color:${BRAND};text-align:right;">${peso(r.summary.balanceAfter)}</td></tr>
          </table>
        </td></tr>
      </table>` : "";

  const noteHtml = r.note ? `${spacer(18)}<div style="${FONT}font-size:13px;line-height:1.5;color:#4b5563;background:#f9fafb;border-radius:8px;padding:10px 14px;">${esc(r.note)}</div>` : "";

  const penaltyHtml = (r.penalties || []).map((p, i, all) => box(`
            ${boxTitle(all.length > 1 ? `Penalty ${i + 1}` : "Penalty charges")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${p.items.map((it) => pair(it.description, peso(it.amount))).join("")}
              ${p.total == null ? "" : `
              <tr><td colspan="2" style="padding:4px 0;"><div style="border-top:1px solid #e5e7eb;"></div></td></tr>
              ${pair("Penalty total", peso(p.total))}
              ${p.paidBefore > 0 ? pair("Paid before", peso(p.paidBefore)) : ""}
              ${p.coveredByDeposit > 0 ? pair("Covered by security deposit", peso(p.coveredByDeposit)) : ""}
              ${pair("This payment", peso(p.thisPayment))}
              ${pair("Remaining", peso(p.remaining), true)}`}
            </table>`)).join("");

  const depositHtml = r.depositSummary ? box(`
            ${boxTitle("Security deposit")}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${pair("Deposit held", peso(r.depositSummary.held))}
              ${pair("Used for penalties", peso(r.depositSummary.usedForPenalties))}
              ${pair("Returned to you", peso(r.depositSummary.returned), true)}
            </table>`) : "";

  const contact = [r.business.address, [r.business.phone, r.business.email].filter(Boolean).join(" · ")].filter(Boolean)
    .map((t) => `<div style="${FONT}font-size:13px;color:#c7d2fe;line-height:1.5;">${esc(t)}</div>`).join("");

  const bodyHtml = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">

      <tr><td align="center" style="background:${BRAND};padding:30px 24px;">
        <div style="${FONT}font-size:22px;font-weight:bold;color:#ffffff;padding-bottom:6px;">${esc(r.business.name)}</div>
        ${contact}
      </td></tr>

      <tr><td align="center" style="padding:30px 32px 8px;">
        <div style="${FONT}display:inline-block;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND};background:#eff6ff;border-radius:999px;padding:6px 14px;">${esc(r.title)}${r.isCopy ? " · copy" : ""}</div>
        <div style="${FONT}font-size:15px;color:#374151;padding:18px 0 6px;">Hi ${esc(customer)}, here is your ${out ? "slip" : "receipt"}.</div>
        <div style="${FONT}font-size:36px;font-weight:bold;color:#111827;line-height:1.2;">${peso(r.total)}</div>
        <div style="${FONT}font-size:13px;color:#6b7280;padding-top:4px;">${out ? "Total returned" : "Total received"} · ${esc(when(r.date))}</div>
      </td></tr>

      <tr><td style="padding:8px 32px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${sectionTitle("Details")}
          ${row("Receipt no.", r.receiptNo, true)}${row(out ? "Paid to" : "Received from", r.customer.name)}
          ${row("Booking", r.booking?.bookingID)}${row("Vehicle", r.booking?.vehicle)}${row("Rental period", period)}
        </table>

        ${spacer(22)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:10px;">
          <tr><td style="padding:14px 20px 10px;">
            <div style="${FONT}font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND};padding-bottom:4px;">${out ? "Returned" : "Paid for"}</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}
              <tr>
                <td style="${FONT}padding:12px 0 4px;border-top:1px solid #e5e7eb;font-size:15px;font-weight:bold;color:#111827;">${out ? "Total returned" : "Total received"}</td>
                <td style="${FONT}padding:12px 0 4px 16px;border-top:1px solid #e5e7eb;font-size:17px;font-weight:bold;color:#111827;text-align:right;white-space:nowrap;">${peso(r.total)}</td>
              </tr>
            </table>
          </td></tr>
        </table>

        ${noteHtml}${penaltyHtml}${depositHtml}

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${sectionTitle("Payment")}
          ${row("Method", METHOD[r.method] || r.method)}${row("Channel", r.source === "in_person" ? "In person" : "Online (PayMongo)")}
          ${row("Reference no.", r.referenceNumber)}${row(out ? "Handed back by" : "Received by", r.handledBy)}
        </table>
        ${summary}
      </td></tr>

      <tr><td style="background:#f9fafb;border-top:1px solid #eef0f3;padding:20px 32px;">
        <div style="${FONT}font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">This is a system-generated acknowledgment of the transaction above.<br>Please keep it for your records and don't reply directly to this email.</div>
      </td></tr>

    </table>
  </td></tr>
</table>`;

  return { subject: `${r.title} ${r.receiptNo}${r.booking?.bookingID ? ` — Booking ${r.booking.bookingID}` : ""}`, bodyHtml };
};

// One send through the shared EmailJS template. Used by the receipt email and the booking statement email.
export const sendEmailJS = async ({ subject, bodyHtml, toEmail }) => {
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

export const sendReceiptEmail = async ({ receipt, toEmail }) => {
  const { subject, bodyHtml } = renderReceiptEmail(receipt);
  return sendEmailJS({ subject, bodyHtml, toEmail });
};