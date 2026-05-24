/**
 * bookingWatcher.js
 *
 * Logic:
 * - Frontend reads DIRECTLY from "bookings" collection (pending + cancellation_request)
 *   so NO notification docs are written here.
 *
 * - This watcher watches ALL bookings for STATUS CHANGES.
 *   When a booking moves OUT of pending/cancellation_request
 *   (i.e. → approved, completed, cancelled),
 *   its full data is saved to "notificationsArchive" collection
 *   so there's a permanent record of what was notified.
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// Statuses that are "active" in notifications (shown in bell/alerts)
const ACTIVE_STATUSES = new Set(["pending", "cancellation_request"]);

// Statuses that mean the booking moved out of notifications
const ARCHIVE_STATUSES = new Set(["approved", "completed", "cancelled"]);

export const startBookingWatcher = () => {
  console.log("🔔 [BookingWatcher] Watching bookings for archive on status change...");

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

        // Only archive if it was previously an "active" notification status
        // and now moved to a resolved status
        if (ACTIVE_STATUSES.has(prev) && ARCHIVE_STATUSES.has(status)) {
          console.log(`📦 [BookingWatcher] Archiving booking ${docID}: ${prev} → ${status}`);

          try {
            await db.collection("notificationsArchive").add({
              // Full booking snapshot
              bookingDocID:  docID,
              bookingID:     booking.bookingID || docID,
              userID:        booking.userID    || "",
              carID:         booking.carID     || "",
              previousStatus: prev,
              resolvedStatus: status,
              startDateTime:  booking.startDateTime || null,
              endDateTime:    booking.endDateTime   || null,
              location:       booking.location      || "",
              notesAdmin:     booking.notesAdmin    || "",
              notesUser:      booking.notesUser     || "",
              archivedAt:     admin.firestore.FieldValue.serverTimestamp(),
            });

            console.log(`✅ [BookingWatcher] Archived booking ${docID} to notificationsArchive`);
          } catch (err) {
            console.error(`❌ [BookingWatcher] Failed to archive ${docID}:`, err.message);
          }
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
