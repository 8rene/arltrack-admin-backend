import { runScheduledRefunds } from "../services/refundRequest/refundRequest.service.js";
import { syncPendingRefunds } from "../services/refundRequest/refundSync.service.js";
import { runScheduledDepositReturns } from "../services/depositReturn/depositReturn.service.js";

// Runs right after midnight Manila time (see vercel.json). Same-day payments can't be partially refunded by PayMongo, so
// their refunds are approved the day they are asked for and SENT here, the next day.
export const runScheduledRefundsJob = async () => {
  const result = await runScheduledRefunds();
  console.log(`[CRON] scheduled-refunds: sent ${result.sent}, failed ${result.failed}, skipped (already failed, waiting for staff) ${result.skipped}.`);
  if (result.errors.length) console.warn("[CRON] scheduled-refunds issues:", result.errors);

  // Same-day security-deposit / discount returns saved with a sendAfter (see depositReturn.service.js). Isolated like the sync
  // below: a problem here must never stop the refund sends above or the sync after it.
  try {
    const dep = await runScheduledDepositReturns();
    console.log(`[CRON] scheduled-deposit-returns: sent ${dep.sent}, failed ${dep.failed}, skipped ${dep.skipped}.`);
    if (dep.errors.length) console.warn("[CRON] scheduled-deposit-returns issues:", dep.errors);
    result.depositReturns = dep;
  } catch (e) {
    console.error("[CRON] scheduled-deposit-returns failed:", e.message);
    result.depositReturns = { error: e.message };
  }

  // Safety net: any refund that PayMongo has already finished but whose webhook never updated us is checked here
  // (anything still "pending" for more than 30 minutes). A failure here must never fail the scheduled sends above.
  try {
    const sync = await syncPendingRefunds({ olderThanMinutes: 30 });
    console.log(`[CRON] refund-sync: checked ${sync.checked}, confirmed ${sync.completed}, failed ${sync.failed}, still pending ${sync.stillPending}.`);
    if (sync.errors.length) console.warn("[CRON] refund-sync issues:", sync.errors);
    return { ...result, sync };
  } catch (e) {
    console.error("[CRON] refund-sync failed:", e.message);
    return { ...result, sync: { error: e.message } };
  }
};