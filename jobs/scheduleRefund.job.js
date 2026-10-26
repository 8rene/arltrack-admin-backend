import { runScheduledRefunds } from "../services/refundRequest/refundRequest.service.js";

// Runs right after midnight Manila time (see vercel.json). Same-day payments can't be partially refunded by PayMongo, so
// their refunds are approved the day they are asked for and SENT here, the next day. Also approves any grace-window
// request whose automatic approval call from the customer backend never arrived.
export const runScheduledRefundsJob = async () => {
  const result = await runScheduledRefunds();
  console.log(`[CRON] scheduled-refunds: auto-approved ${result.autoApproved}, sent ${result.sent}, retry later ${result.retryLater}, failed ${result.failed}.`);
  if (result.errors.length) console.warn("[CRON] scheduled-refunds issues:", result.errors);
  return result;
};