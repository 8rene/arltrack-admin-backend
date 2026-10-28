import { sweepExpiredSessions } from "../services/sessionLogs/sessionLogs.service.js";
import { auditSafe } from "../services/auditLogs/auditLogs.service.js";

// Backstop for the lazy expiry check in auth.controller.js's login flow.
// That check only fires when an account logs back in — this catches
// everyone else (abandoned sessions from accounts that never return),
// so a dead session doesn't sit marked "active" forever just because
// nobody happened to trigger the lazy check.
export const runExpireSessions = async () => {
  const count = await sweepExpiredSessions();
  console.log(`[CRON] expire-sessions: marked ${count} stale session(s) as expired.`);
  // One summary line, and only when something actually expired (quiet nights write nothing).
  if (count > 0) {
    await auditSafe({
      action: "system",
      description: `Scheduled job: marked ${count} stale session(s) as expired.`,
      userID: "system",
    });
  }
  return { expiredCount: count };
};