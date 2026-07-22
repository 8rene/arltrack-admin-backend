/**
 * bookingDelete.service.js
 *
 * Cascading archive-then-delete for a booking and its linked documents.
 *
 * Order of operations (all inside a Firestore batch / sequential writes):
 *  1. Archive booking        → bookingArchives
 *  2. Archive payment        → paymentsArchives      (if a payment exists)
 *  3. Archive reviews        → reviewsArchives        (if any reviews exist)
 *  4. Archive bookingSession → bookingSessionArchives (if one exists) —
 *     including its archive/{date} GPS-trail subcollection, copied doc-for-
 *     doc under the new archive record. Copying the day-docs (not just
 *     relying on archiveUrl) matters because a session that was never
 *     flushed to Storage — e.g. the booking gets deleted the same day,
 *     before that night's cron runs — would otherwise lose its GPS trail
 *     entirely once the live doc is deleted.
 *  5. Delete booking         from bookings
 *  6. Delete payment         from payments          (if one was found)
 *  7. Delete reviews         from reviews           (if any were found)
 *  8. Delete bookingSession  from bookingSessions, and its archive
 *     subcollection             (if one was found)
 *
 * If any archive write fails the function throws before touching deletes,
 * so the source documents are never lost.
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

/**
 * Fetches the booking document and returns { docRef, data }.
 * Throws if not found.
 */
const fetchBooking = async (bookingDocID) => {
  const docRef = db.collection("bookings").doc(bookingDocID);
  const docSnap = await docRef.get();
  if (!docSnap.exists) throw new Error(`Booking not found: ${bookingDocID}`);
  return { docRef, data: docSnap.data() };
};

/**
 * Fetches the payment document linked to a bookingID.
 * Returns { docRef, data } or null if none found.
 */
const fetchPayment = async (bookingID) => {
  const snap = await db
    .collection("payments")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { docRef: doc.ref, data: doc.data() };
};

/**
 * Fetches all review documents linked to a bookingID.
 * Returns an array of { docRef, data } (may be empty).
 */
const fetchReviews = async (bookingID) => {
  const snap = await db
    .collection("reviews")
    .where("bookingID", "==", bookingID)
    .get();

  if (snap.empty) return [];
  return snap.docs.map((doc) => ({ docRef: doc.ref, data: doc.data() }));
};

/**
 * Fetches the bookingSession document linked to a bookingID (bookingID is
 * an FK field on the doc, not the doc's own ID — see
 * models/bookingSession/bookingsession.model.js). Returns { docRef, data }
 * or null if this booking never got a session (e.g. cancelled before any
 * tracking data existed).
 */
const fetchBookingSession = async (bookingID) => {
  const snap = await db
    .collection("bookingSessions")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { docRef: doc.ref, data: doc.data() };
};

/**
 * Fetches every day-doc in a session's archive/{date} GPS-trail
 * subcollection. Returns an array of { docRef, data } (may be empty —
 * a session that never got a single ping has no day-docs at all).
 */
const fetchSessionArchiveDays = async (sessionRef) => {
  const snap = await sessionRef.collection("archive").get();
  if (snap.empty) return [];
  return snap.docs.map((doc) => ({ docRef: doc.ref, data: doc.data() }));
};

// ─────────────────────────────────────────────────────────────
// Archive writers
// ─────────────────────────────────────────────────────────────

/**
 * Writes a booking archive document.
 * Returns the new bookingArchivesID.
 */
const archiveBooking = async (bookingDocID, bookingData, archivedBy = "admin") => {
  const archiveRef = db.collection("bookingArchives").doc(); // auto-ID

  const archiveDoc = {
    bookingArchivesID : archiveRef.id,          // new archive doc ID
    bookingID         : bookingData.bookingID ?? bookingDocID, // original booking ID
    originalId        : bookingDocID,            // Firestore doc ID for restore
    archiveDate       : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt        : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    userID            : bookingData.userID ?? "",
    // ── spread all original booking fields ──
    ...bookingData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] Booking archived → bookingArchives/${archiveRef.id}`);
  return archiveRef.id;
};

/**
 * Writes a payment archive document.
 * Returns the new paymentsArchivesID.
 */
const archivePayment = async (paymentDocID, paymentData, archivedBy = "admin") => {
  const archiveRef = db.collection("paymentsArchives").doc(); // auto-ID

  const archiveDoc = {
    paymentsArchivesID : archiveRef.id,
    paymentID          : paymentData.paymentID ?? paymentDocID,
    originalId         : paymentDocID,
    archiveDate        : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt         : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // ── spread all original payment fields ──
    ...paymentData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] Payment archived → paymentsArchives/${archiveRef.id}`);
  return archiveRef.id;
};

/**
 * Writes a single review archive document.
 * Returns the new reviewsArchivesID.
 */
const archiveReview = async (reviewDocID, reviewData, archivedBy = "admin") => {
  const archiveRef = db.collection("reviewsArchives").doc(); // auto-ID

  const archiveDoc = {
    reviewsArchivesID : archiveRef.id,
    reviewID          : reviewData.reviewID ?? reviewDocID,
    originalId        : reviewDocID,
    archiveDate       : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt        : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // ── spread all original review fields ──
    ...reviewData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] Review archived → reviewsArchives/${archiveRef.id}`);
  return archiveRef.id;
};

/**
 * Writes a bookingSession archive document, plus a copy of every archive
 * day-doc underneath it (archiveDays — not a live subcollection, just an
 * array field, since this record is a dead snapshot and never needs
 * per-day querying the way the live session did).
 * Returns the new bookingSessionArchivesID.
 */
const archiveBookingSession = async (sessionDocID, sessionData, archiveDays, archivedBy = "admin") => {
  const archiveRef = db.collection("bookingSessionArchives").doc(); // auto-ID

  const archiveDoc = {
    bookingSessionArchivesID : archiveRef.id,
    bookingSessionID         : sessionData.bookingSessionID ?? sessionDocID,
    originalId                : sessionDocID,
    archiveDate                : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt                  : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // Flattened GPS trail, day-doc order preserved — same shape
    // flushSessionArchive() writes to Storage, so this stays reconstructable
    // even if archiveUrl below is null (session deleted before ever flushed).
    archiveDays : archiveDays.map(({ docRef, data }) => ({ date: docRef.id, ...data })),
    // ── spread all original session fields (includes archiveUrl if it was
    // ever flushed to Storage, sessionStatus, geofenceAlerts, etc.) ──
    ...sessionData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] BookingSession archived → bookingSessionArchives/${archiveRef.id}`);
  return archiveRef.id;
};

// ─────────────────────────────────────────────────────────────
// Main exported function
// ─────────────────────────────────────────────────────────────

/**
 * deleteBookingWithCascade
 *
 * @param {string} bookingDocID  - Firestore document ID inside "bookings"
 * @param {string} [archivedBy] - Who triggered the deletion (for audit trail)
 * @returns {object} Summary of what was archived / deleted
 */
export const deleteBookingWithCascade = async (bookingDocID, archivedBy = "admin") => {
  // ── 1. Fetch source documents (fail fast if booking missing) ──────────────
  const { docRef: bookingRef, data: bookingData } = await fetchBooking(bookingDocID);

  // The bookingID stored inside the document (may differ from Firestore doc ID)
  const bookingID = bookingData.bookingID ?? bookingDocID;

  const paymentResult = await fetchPayment(bookingID);
  const reviewResults = await fetchReviews(bookingID);
  const sessionResult = await fetchBookingSession(bookingID);
  const sessionArchiveDays = sessionResult
    ? await fetchSessionArchiveDays(sessionResult.docRef)
    : [];

  console.log(
    `[DELETE] Booking ${bookingDocID} | ` +
    `payment: ${paymentResult ? "found" : "none"} | ` +
    `reviews: ${reviewResults.length} | ` +
    `session: ${sessionResult ? "found" : "none"} (${sessionArchiveDays.length} archive day-doc(s))`
  );

  // ── 2. Archive phase (must all succeed before any delete) ─────────────────
  let bookingArchivesID;
  let paymentsArchivesID = null;
  let bookingSessionArchivesID = null;
  const reviewsArchivesIDs = [];

  try {
    // 2a. Archive booking
    bookingArchivesID = await archiveBooking(bookingDocID, bookingData, archivedBy);

    // 2b. Archive payment (if exists)
    if (paymentResult) {
      paymentsArchivesID = await archivePayment(
        paymentResult.docRef.id,
        paymentResult.data,
        archivedBy
      );
    }

    // 2c. Archive every review (if any exist)
    for (const { docRef: reviewRef, data: reviewData } of reviewResults) {
      const id = await archiveReview(reviewRef.id, reviewData, archivedBy);
      reviewsArchivesIDs.push(id);
    }

    // 2d. Archive bookingSession, with its GPS-trail day-docs folded in (if exists)
    if (sessionResult) {
      bookingSessionArchivesID = await archiveBookingSession(
        sessionResult.docRef.id,
        sessionResult.data,
        sessionArchiveDays,
        archivedBy
      );
    }
  } catch (archiveError) {
    // If any archive write fails, stop immediately — nothing has been deleted yet.
    console.error("[DELETE] Archive phase failed — aborting, source data is safe:", archiveError);
    throw new Error(
      `Archive failed before any deletion. Source data is intact. Reason: ${archiveError.message}`
    );
  }

  // ── 3. Delete phase (only reached if all archives succeeded) ──────────────
  try {
    const batch = db.batch();

    // 3a. Delete booking
    batch.delete(bookingRef);

    // 3b. Delete payment
    if (paymentResult) {
      batch.delete(paymentResult.docRef);
    }

    // 3c. Delete reviews
    for (const { docRef: reviewRef } of reviewResults) {
      batch.delete(reviewRef);
    }

    // 3d. Delete bookingSession + every archive day-doc underneath it.
    // Firestore doesn't cascade-delete subcollections — each day-doc has
    // to be deleted individually, which is why they're in this same batch
    // rather than a separate step. (A session realistically has at most a
    // few dozen day-docs — one rental's worth of days — nowhere close to
    // the 500-write batch limit alongside the other deletes here.)
    if (sessionResult) {
      batch.delete(sessionResult.docRef);
      for (const { docRef: dayRef } of sessionArchiveDays) {
        batch.delete(dayRef);
      }
    }

    await batch.commit();
    console.log(`[DELETE] Batch delete committed for booking ${bookingDocID}`);
  } catch (deleteError) {
    // Archives already written but deletes failed.
    // Log clearly so an admin can manually reconcile if needed.
    console.error(
      "[DELETE] Delete phase failed AFTER archives were written. " +
      "Duplicate data may exist. Manual cleanup may be required.",
      deleteError
    );
    throw new Error(
      `Deletion failed after archiving. Archives were created but source documents were NOT deleted. ` +
      `Reason: ${deleteError.message}`
    );
  }

  // ── 4. Return summary ─────────────────────────────────────────────────────
  return {
    success          : true,
    bookingDocID,
    bookingID,
    bookingArchivesID,
    paymentsArchivesID,
    bookingSessionArchivesID,
    reviewsArchivesIDs,
    reviewsArchivedCount : reviewResults.length,
    sessionArchived       : Boolean(sessionResult),
    sessionArchiveDaysCount : sessionArchiveDays.length,
    message          :
      `Booking ${bookingDocID} and ${paymentResult ? 1 : 0} payment(s), ` +
      `${reviewResults.length} review(s), ` +
      `${sessionResult ? 1 : 0} session (${sessionArchiveDays.length} archive day-doc(s)) ` +
      `archived and deleted successfully.`,
  };
};