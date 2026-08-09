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
import { sendLicenseExpiryEmail } from "../services/email/email.service.js";
import { ROLE_IDS } from "../utils/roles/role.util.js";

// ── Driver's license expiry check ─────────────────────────────────
// Piggybacks on this same daily cron, same reasoning as the overdue-booking
// check above: daily granularity is fine for this, no separate schedule
// needed. Scoped to Driver/Supervisor accounts only — customer enforcement
// is out of scope for now (customer app is owned by another dev).
//
// Auto-lock is intentionally one-directional here: an expired license locks
// the account automatically (no grace period — this is a legal/compliance
// requirement, not just a UX nicety), but a renewed date does NOT
// auto-unlock. Un-flipping status back to "active" is left as a manual
// admin action (Users.jsx's existing status dropdown) so a typo'd expiry
// date can't both wrongly lock AND wrongly auto-unlock someone with zero
// human involved either way.
const LICENSE_WARNING_DAYS = 14;

const parseExpiry = (val) => {
  if (!val) return null;
  if (typeof val?.toDate === "function") return val.toDate();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
};

const checkLicenseExpiry = async () => {
  const now = new Date();
  const docsSnap = await db.collection("userDocument").get();

  for (const docSnap of docsSnap.docs) {
    const data = docSnap.data();
    const expiry = parseExpiry(data.driverLicenseExpiry);
    if (!expiry || !data.userID) continue;

    const userRef  = db.collection("user").doc(data.userID);
    const userSnap = await userRef.get();
    if (!userSnap.exists) continue;
    const userData = userSnap.data();

    // Only Driver/Supervisor accounts — see note above.
    if (userData.roleID !== ROLE_IDS.DRIVER && userData.roleID !== ROLE_IDS.SUPERVISOR) continue;

    const refID = data.userID;
    const msLeft = expiry.getTime() - now.getTime();
    const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    const isExpired = msLeft < 0;
    const isWarning = !isExpired && daysLeft <= LICENSE_WARNING_DAYS;
    const toName = userData.username || userData.email || "Team Member";
    const expiryDateLabel = expiry.toDateString();

    if (isExpired) {
      await resolveNotification("license_expiring", refID).catch(() => {});

      // Check-before-create so the email only fires the first time this
      // account crosses into "expired" (not every night it stays expired).
      const existing = await db.collection("notifications")
        .where("type", "==", "license_expired")
        .where("refID", "==", refID)
        .where("status", "==", "active")
        .limit(1).get();
      const isNewNotif = existing.empty;

      await createNotification({
        type: "license_expired",
        refID,
        refCollection: "user",
        title: "Driver's license expired",
        message: `${toName}'s driver's license expired on ${expiryDateLabel}. Account auto-locked.`,
      }).catch((err) => console.error("[NOTIF] license_expired create failed:", err.message));

      if (isNewNotif && userData.email) {
        await sendLicenseExpiryEmail({ toEmail: userData.email, toName, isExpired: true, expiryDate: expiryDateLabel })
          .catch((err) => console.error("[EMAIL] license_expired send failed:", err.message));
      }

      if (userData.status !== "locked") {
        await userRef.update({ status: "locked" })
          .catch((err) => console.error("[CRON] auto-lock failed for", refID, err.message));
      }
    } else if (isWarning) {
      const existing = await db.collection("notifications")
        .where("type", "==", "license_expiring")
        .where("refID", "==", refID)
        .where("status", "==", "active")
        .limit(1).get();
      const isNewNotif = existing.empty;

      await createNotification({
        type: "license_expiring",
        refID,
        refCollection: "user",
        title: "Driver's license expiring soon",
        message: `${toName}'s driver's license expires in ${daysLeft} day(s) (${expiryDateLabel}).`,
      }).catch((err) => console.error("[NOTIF] license_expiring create failed:", err.message));

      if (isNewNotif && userData.email) {
        await sendLicenseExpiryEmail({ toEmail: userData.email, toName, isExpired: false, daysLeft, expiryDate: expiryDateLabel })
          .catch((err) => console.error("[EMAIL] license_expiring send failed:", err.message));
      }
    } else {
      await resolveNotification("license_expiring", refID).catch(() => {});
      await resolveNotification("license_expired", refID).catch(() => {});
    }
  }
};

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

  await checkLicenseExpiry().catch((err) =>
    console.error("[CRON] ❌ License expiry check failed:", err.message)
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