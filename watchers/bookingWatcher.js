/**
 * bookingWatcher.js
 *
 * Logic:
 * - Frontend reads DIRECTLY from "bookings" collection (cancellation_request)
 *   so NO notification docs are written here. New bookings land straight in
 *   "upcoming" now (no more "pending" awaiting approval), so only
 *   cancellation requests need bell attention.
 *
 * - This watcher tracks status changes for logging purposes only.
 *   Archiving to "notificationsArchive" is handled by booking.service.js
 *   to avoid duplicate records.
 */

import { db } from "../config/firebaseConnection/firebase.js";

// Statuses that are "active" in notifications (shown in bell/alerts)
const ACTIVE_STATUSES = new Set(["cancellation_request"]);

// Statuses that mean the booking moved out of notifications
const ARCHIVE_STATUSES = new Set(["upcoming", "ongoing", "completed", "cancelled"]);

export const startBookingWatcher = () => {
  console.log("🔔 [BookingWatcher] Watching bookings for status changes...");

  // Track last known status per booking doc
  const lastStatus = new Map();

  db.collection("bookings").onSnapshot(async (snap) => {
    for (const change of snap.docChanges()) {
      const docID   = change.doc.id;
      const booking = change.doc.data();
      const status  = booking.status?.toLowerCase();

      if (change.type === "added") {
        // Just record the initial status, no archive needed
        lastStatus.set(docID, status);
        continue;
      }

      if (change.type === "modified") {
        const prev = lastStatus.get(docID);
        lastStatus.set(docID, status);

        // Just log the status change — archiving is handled by booking.service.js
        if (ACTIVE_STATUSES.has(prev) && ARCHIVE_STATUSES.has(status)) {
          console.log(`📦 [BookingWatcher] Status changed ${docID}: ${prev} → ${status}`);
        }
      }

      if (change.type === "removed") {
        lastStatus.delete(docID);
      }
    }
  }, (err) => {
    console.error("[BookingWatcher] Snapshot error:", err);
  });
};
