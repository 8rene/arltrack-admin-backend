// ================================
//  CRON — midnight archive flush
//  For every session still active (car currently on trip), compile its
//  full GPS trail so far and upload a permanent copy to Firebase Storage,
//  overwriting the previous night's file.
//
//  Simpler than the test backend's version: there's no Sheets-tab deletion
//  race to guard against here, since the archive subcollection this reads
//  from is permanent Firestore data, not a rotating 3-day buffer. A failed
//  flush just means that session's Storage copy is stale until the next
//  successful run — nothing is ever deleted, so nothing is ever at risk of
//  being lost. One session's failure is still isolated so it can't stop the
//  rest of the fleet from being flushed.
// ================================

import { getAllActiveSessions } from "../services/booking/bookingSession.service.js";
import { flushBookingHistory } from "../services/storage/bookingHistory.service.js";

export const runMidnightFlush = async () => {
  console.log("[CRON] ⏰ Midnight archive flush starting...");

  const activeSessions = await getAllActiveSessions().catch((err) => {
    console.error("[CRON] ❌ Failed to load active sessions:", err.message);
    return [];
  });

  let succeeded = 0;
  let failed = 0;

  for (const { data } of activeSessions) {
    try {
      await flushSessionArchive(data.bookingSessionID);
      succeeded++;
    } catch (err) {
      failed++;
      console.error(
        `[CRON] ❌ Failed to flush session ${data.bookingSessionID}:`,
        err.message
      );
      // Deliberately no early return / throw here — one bad session must
      // never stop the rest of the fleet from being archived tonight.
    }
  }

  console.log(
    `[CRON] ✅ Midnight archive flush complete — ${succeeded} succeeded, ${failed} failed, ${activeSessions.length} active session(s) total.`
  );
};