/**
 * bookingWatcher.js
 *
 * Bookings land straight in "upcoming" at creation now — there is no
 * "pending awaiting approval" state anymore (see bookings.controller.js
 * in the customer backend). So the only booking-side event that still
 * needs admin attention is a cancellation request.
 *
 * This watcher creates a real `notifications` doc (via notification.service.js)
 * the moment a booking's status transitions INTO "cancellation_request",
 * and auto-resolves it the moment the booking moves back OUT of that
 * status (admin approved/rejected it, or it changed some other way).
 */

import { db } from "../config/firebaseConnection/firebase.js";
import { createNotification, resolveNotification } from "../services/notification/notification.service.js";

const ACTIVE_STATUSES = new Set(["cancellation_request"]);

export const startBookingWatcher = () => {
  console.log("🔔 [BookingWatcher] Watching bookings for status changes...");

  const lastStatus = new Map();

  db.collection("bookings").onSnapshot(async (snap) => {
    for (const change of snap.docChanges()) {
      const docID   = change.doc.id;
      const booking = change.doc.data();
      const status  = booking.status?.toLowerCase();

      if (change.type === "added") {
        lastStatus.set(docID, status);
        // A booking can theoretically be created directly in cancellation_request
        // (unlikely, but handle it) — otherwise nothing to do on add.
        if (ACTIVE_STATUSES.has(status)) {
          await createNotification({
            type: "cancellation_request",
            refID: docID,
            refCollection: "bookings",
            title: "Cancellation request",
            message: `Booking ${booking.bookingID || docID} has a pending cancellation request.`,
          });
        }
        continue;
      }

      if (change.type === "modified") {
        const prev = lastStatus.get(docID);
        lastStatus.set(docID, status);

        if (!ACTIVE_STATUSES.has(prev) && ACTIVE_STATUSES.has(status)) {
          // Just entered cancellation_request — create the alert
          await createNotification({
            type: "cancellation_request",
            refID: docID,
            refCollection: "bookings",
            title: "Cancellation request",
            message: `Booking ${booking.bookingID || docID} has a pending cancellation request.`,
          });
        } else if (ACTIVE_STATUSES.has(prev) && !ACTIVE_STATUSES.has(status)) {
          // Left cancellation_request — resolved/rejected, clear the alert
          await resolveNotification("cancellation_request", docID);
        }
      }

      if (change.type === "removed") {
        lastStatus.delete(docID);
        await resolveNotification("cancellation_request", docID);
      }
    }
  }, (err) => {
    console.error("[BookingWatcher] Snapshot error:", err);
  });
};