import { runScheduledRefunds } from "../services/refundRequest/refundRequest.service.js";

// Runs right after midnight Manila time (see vercel.json). Same-day payments can't be partially refunded by PayMongo, so
// their refunds are approved the day they are asked for and SENT here, the next day.
export const runScheduledRefundsJob = async () => {
  const result = await runScheduledRefunds();
  console.log(`[CRON] scheduled-refunds: sent ${result.sent}, failed ${result.failed}, skipped (already failed, waiting for staff) ${result.skipped}.`);
  if (result.errors.length) console.warn("[CRON] scheduled-refunds issues:", result.errors);
  return result;
};