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
import { db } from "../config/firebaseConnection/firebase.js";
import { createNotification, resolveNotification } from "../services/notification/notification.service.js";

// ── Pickup/return overdue checks ──────────────────────────────────
// Piggybacks on this same daily cron rather than a separate job —
// daily granularity is fine for these (unlike a "10 minutes before
// pickup" reminder, which would need a much more frequent schedule
// this project's current Vercel Cron plan doesn't support).
const checkOverdueBookings = async () => {
  const now = new Date();
  const snap = await db.collection("bookings")
    .where("status", "in", ["upcoming", "ongoing"])
    .get();

  for (const doc of snap.docs) {
    const booking = doc.data();
    const docID = doc.id;

    // Pickup overdue: still "upcoming" (never picked up) past its startDateTime
    if (booking.status === "upcoming" && booking.startDateTime?.toDate?.() < now) {
      await createNotification({
        type: "pickup_overdue",
        refID: docID,
        refCollection: "bookings",
        title: "Pickup overdue",
        message: `Booking ${booking.bookingID || docID} was due for pickup but hasn't started.`,
      }).catch((err) => console.error("[NOTIF] pickup_overdue create failed:", err.message));
    } else {
      await resolveNotification("pickup_overdue", docID).catch(() => {});
    }

    // Return overdue: still "ongoing" past its endDateTime
    if (booking.status === "ongoing" && booking.endDateTime?.toDate?.() < now) {
      await createNotification({
        type: "return_overdue",
        refID: docID,
        refCollection: "bookings",
        title: "Return overdue",
        message: `Booking ${booking.bookingID || docID} is past its return time.`,
      }).catch((err) => console.error("[NOTIF] return_overdue create failed:", err.message));
    } else {
      await resolveNotification("return_overdue", docID).catch(() => {});
    }
  }
};

export const runMidnightFlush = async () => {
  await checkOverdueBookings().catch((err) =>
    console.error("[CRON] ❌ Overdue booking check failed:", err.message)
  );

  console.log("[CRON] ⏰ Midnight archive flush starting...");

  const activeSessions = await getAllActiveSessions().catch((err) => {
    console.error("[CRON] ❌ Failed to load active sessions:", err.message);
    return [];
  });

  let succeeded = 0;
  let failed = 0;

  for (const { data } of activeSessions) {
    try {
      await flushBookingHistory(data.bookingSessionID);
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