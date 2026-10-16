// Emails the Booking Statement (the object built by statement.service.js) to the customer.
// Same delivery as the receipt email: the statement is written INTO the email body (inline styles, no PDF, nothing stored)
// and goes out through the shared EmailJS template, so no new settings are needed.
//
// Spacing: every gap between blocks is an explicit spacer (`gap()`), not a CSS margin on a <table>. Outlook for Windows
// ignores margin-top on tables, which is what made stacked blocks touch; a fixed-height cell works everywhere.
import { esc, peso, when, day, METHOD, BRAND, FONT, row, sectionTitle, pair, boxTitle, sendEmailJS } from "./receiptEmail.service.js";

const gap = (px = 16) => `<div style="height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</div>`;
const rule = `<tr><td colspan="2" style="padding:6px 0;"><div style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;height:1px;">&nbsp;</div></td></tr>`;

// a rounded block: grey by default, blue for the overall figures, amber for anything not done yet
const TONE = { grey: "#f9fafb", blue: "#eff6ff", amber: "#fffbeb" };
const card = (inner, tone = "grey") => `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${TONE[tone]};border-radius:10px;">
          <tr><td style="padding:14px 20px;">${inner}</td></tr>
        </table>`;
const lines = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;
const muted = (text) => `<div style="${FONT}font-size:13px;line-height:1.5;color:#6b7280;font-style:italic;">${esc(text)}</div>`;

// one money movement: label + amount, with a small grey line (date · method · reference) under it
const detailLine = (l) => [when(l.date), METHOD[l.method] || l.method, l.source === "in_person" ? "In person" : null, l.referenceNumber ? `Ref. ${l.referenceNumber}` : null]
  .filter((v) => v && v !== "—").join(" · ");
const itemRow = (label, detail, amountHtml, bold = true) => `
            <tr>
              <td style="${FONT}padding:7px 0;font-size:14px;color:#1f2937;vertical-align:top;">${esc(label)}${detail ? `<div style="${FONT}font-size:12px;line-height:1.5;color:#6b7280;padding-top:2px;">${esc(detail)}</div>` : ""}</td>
              <td style="${FONT}padding:7px 0 7px 16px;font-size:14px;${bold ? "font-weight:bold;" : ""}color:#111827;text-align:right;white-space:nowrap;vertical-align:top;">${amountHtml}</td>
            </tr>`;
const moveRows = (list, numbered = false, bold = true) => list.map((l, i) => itemRow(`${numbered ? `${i + 1}. ` : ""}${l.label}`, detailLine(l), peso(l.amount), bold)).join("");

const PENDING_LABEL = { pending: "Pending", unrefundable: "Can't be refunded" };
const DEPOSIT_LABEL = { Held: "Still held", Settled: "Settled", Waived: "Waived", Forfeited: "Forfeited", Refunded: "Refunded" };

export const renderStatementEmail = (s) => {
  const customer = s.customer.name && s.customer.name !== "—" ? s.customer.name : "Valued Customer";
  const period = day(s.booking.startDateTime) ? `${day(s.booking.startDateTime)} – ${day(s.booking.endDateTime) || "—"}` : null;
  const o = s.overall;

  // ---- payments
  const paymentsCard = card(`
            ${boxTitle("Payments")}
            ${s.payments.length ? lines(moveRows(s.payments, true)) : muted("No payments have been recorded yet.")}
            ${s.charges ? lines(`
              ${rule}
              ${pair("Booking total", peso(s.charges.total))}
              ${s.charges.discount > 0 ? pair(`Discount applied${s.charges.discountReason ? ` (${s.charges.discountReason})` : ""}`, `−${peso(s.charges.discount)}`) : ""}
              ${pair("Total paid", peso(s.paymentTotals.paid))}
              ${pair("Balance remaining", peso(s.paymentTotals.balanceRemaining), true)}`) : ""}`);

  // ---- pending (listed, never counted)
  const pendingCard = s.pending.length ? gap() + card(`
            ${boxTitle("Pending · not counted in any total")}
            ${lines(s.pending.map((l) => itemRow(`${l.label}${l.direction === "out" ? " (money back to you)" : ""}`, [PENDING_LABEL[l.status] || l.status, detailLine(l)].filter(Boolean).join(" · "), peso(l.amount))).join(""))}`, "amber") : "";

  // ---- penalties
  const penaltyCards = s.penalties.length
    ? s.penalties.map((p, i) => (i ? gap() : "") + card(`
            ${boxTitle(`Penalty ${i + 1}${p.active ? "" : ` · ${p.status} (not counted)`}`)}
            ${lines(`
              ${p.items.map((it) => pair(it.description, peso(it.amount))).join("")}
              ${rule}
              ${pair("Penalty total", peso(p.amount), !p.active)}`)}
            ${p.active ? lines(`${p.payments.length ? moveRows(p.payments, false, false) : ""}
              ${p.coveredByDeposit > 0 ? pair("Covered by security deposit", peso(p.coveredByDeposit)) : ""}
              ${rule}
              ${pair("Still owed on this penalty", peso(p.outstanding), true)}`) : (p.reason ? `<div style="${FONT}font-size:13px;line-height:1.5;color:#6b7280;padding-top:6px;">${esc(p.reason)}</div>` : "")}`)).join("")
    : card(muted("No penalties on this booking."));
  const penaltyTotalsCard = s.penaltyTotals.count > 0 ? gap() + card(`
            ${boxTitle("Penalties total")}
            ${lines(`
              ${pair("Total penalties", peso(s.penaltyTotals.charged))}
              ${pair("Paid (cash / online)", peso(s.penaltyTotals.paid))}
              ${s.penaltyTotals.coveredByDeposit > 0 ? pair("Covered by security deposit", peso(s.penaltyTotals.coveredByDeposit)) : ""}
              ${rule}
              ${pair("Still owed on penalties", peso(s.penaltyTotals.outstanding), true)}`)}`) : "";

  // ---- deposit and refunds
  const depositCard = s.deposit ? gap() + card(`
            ${boxTitle("Security deposit")}
            ${lines(`
              ${pair("Deposit held", peso(s.deposit.held))}
              ${pair("Used for penalties", peso(s.deposit.usedForPenalties))}
              ${pair("Returned to you", peso(s.deposit.returned))}
              ${s.deposit.status ? pair("Status", esc(DEPOSIT_LABEL[s.deposit.status] || s.deposit.status), true) : ""}`)}`) : "";
  const refundsCard = s.refunds.length ? gap() + card(`
            ${boxTitle("Refunds")}
            ${lines(moveRows(s.refunds))}`) : "";

  // ---- overall
  const overallCard = gap(20) + card(`
            ${boxTitle("Overall")}
            ${lines(`
              ${pair("Total charges", peso(o.totalCharges))}
              ${pair("Total paid", peso(o.paidIn))}
              ${o.coveredByDeposit > 0 ? pair("Covered by security deposit", peso(o.coveredByDeposit)) : ""}
              ${o.refunded > 0 ? pair("Refunded to you", peso(o.refunded)) : ""}
              ${o.depositReturned > 0 ? pair("Security deposit returned", peso(o.depositReturned)) : ""}
              ${rule}
              ${pair("Net received", peso(o.netReceived))}
              ${pair("Amount still owed", peso(o.stillOwed), true)}`)}`, "blue");

  const contact = [s.business.address, [s.business.phone, s.business.email].filter(Boolean).join(" · ")].filter(Boolean)
    .map((t) => `<div style="${FONT}font-size:13px;color:#c7d2fe;line-height:1.5;">${esc(t)}</div>`).join("");

  const bodyHtml = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">

      <tr><td align="center" style="background:${BRAND};padding:30px 24px;">
        <div style="${FONT}font-size:22px;font-weight:bold;color:#ffffff;padding-bottom:6px;">${esc(s.business.name)}</div>
        ${contact}
      </td></tr>

      <tr><td align="center" style="padding:30px 32px 8px;">
        <div style="${FONT}display:inline-block;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND};background:#eff6ff;border-radius:999px;padding:6px 14px;">${esc(s.title)}</div>
        ${gap(18)}
        <div style="${FONT}font-size:15px;color:#374151;">Hi ${esc(customer)}, here is the statement for your booking.</div>
        ${gap(10)}
        <div style="${FONT}font-size:36px;font-weight:bold;color:#111827;line-height:1.2;">${peso(o.stillOwed)}</div>
        <div style="${FONT}font-size:13px;color:#6b7280;padding-top:4px;">${o.stillOwed > 0 ? "Amount still owed" : "Nothing owed"} · as of ${esc(when(s.asOf))}</div>
      </td></tr>

      <tr><td style="padding:8px 32px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${sectionTitle("Details")}
          ${row("Statement no.", s.statementNo, true)}${row("Customer", s.customer.name)}
          ${row("Booking", s.booking.bookingID)}${row("Vehicle", s.booking.vehicle)}${row("Rental period", period)}
        </table>
        ${gap(22)}
        ${paymentsCard}
        ${pendingCard}
        ${gap(22)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="${FONT}padding:0 0 8px;font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:${BRAND};">Penalties</td></tr></table>
        ${penaltyCards}${penaltyTotalsCard}
        ${depositCard}${refundsCard}
        ${overallCard}
      </td></tr>

      <tr><td style="background:#f9fafb;border-top:1px solid #eef0f3;padding:20px 32px;">
        <div style="${FONT}font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">This statement shows your booking as of ${esc(when(s.asOf))}. Amounts can change if payments or charges are added later.<br>Please keep it for your records and don't reply directly to this email.</div>
      </td></tr>

    </table>
  </td></tr>
</table>`;

  return { subject: `${s.title} ${s.statementNo} — Booking ${s.booking.bookingID}`, bodyHtml };
};

export const sendStatementEmail = async ({ statement, toEmail }) => {
  const { subject, bodyHtml } = renderStatementEmail(statement);
  return sendEmailJS({ subject, bodyHtml, toEmail });
};