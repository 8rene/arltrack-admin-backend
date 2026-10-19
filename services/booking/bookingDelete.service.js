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
 *  4b. Archive refund requests, penalties  → refundArchives / penaltyArchives
 *  4c. Archive driver assignments, cancellation requests, payment entries
 *      → driverAssignmentArchives / cancellationRequestArchives / paymentEntryArchives
 *      (services/archives/linkedArchives.service.js). Every row linked to the booking, in any status.
 *  4e. Archive the four vehicle inspection collections (part condition + photo links) of the booking into ONE
 *      vehicleInspectionArchives doc (services/archives/vehicleInspectionArchives.service.js). The photo files stay in Storage.
 *  4d. Archive maintenance records linked to the booking (bookingID set; routine maintenance is not) → maintenanceArchives
 *      (services/archives/maintenanceArchives.service.js). Any status.
 *  5. Delete booking         from bookings
 *  6. Delete payment         from payments          (if one was found)
 *  7. Delete reviews         from reviews           (if any were found)
 *  8. Delete bookingSession  from bookingSessions, and its archive
 *     subcollection             (if one was found)
 *  9. Delete the rows archived in 4b / 4c / 4d from their live collections
 *
 * If any archive write fails the function throws before touching deletes,
 * so the source documents are never lost.
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  collectLinkedForBooking,
  writeLinkedArchives,
  linkedLiveRefs,
  chunk,
} from "../archives/linkedArchives.service.js";
import {
  collectMaintenanceForBooking,
  writeMaintenanceArchives,
  maintenanceLiveRefs,
} from "../archives/maintenanceArchives.service.js";
import {
  collectInspectionForBooking,
  writeInspectionArchive,
  inspectionLiveRefs,
} from "../archives/vehicleInspectionArchives.service.js";
import { syncCarPartConditions } from "../carParts/carPartConditions.service.js";
// ═══ DELETE GUARD ═══════════════════════════════════════════════════════════════════════════════════════════
// What is still "in flight" on a booking , so a delete does not silently bury money.
//   blockers  stop the delete. Owner / Admin can force past them (the records are archived, not destroyed);
//             a Supervisor never can.
//   warnings  are shown in the confirm dialog but never stop anything.
const low = (v) => String(v ?? "").trim().toLowerCase();
const num = (v) => Number(v) || 0;
const peso = (n) => `\u20b1${num(n).toLocaleString("en-PH")}`;

export const evaluateGuards = ({ booking = null, payments = [], refunds = [], penalties = [] } = {}) => {
  const blockers = [];
  const warnings = [];
  const bookingStatus = low(booking?.status);

  if (bookingStatus === "ongoing") {
    blockers.push({ code: "trip_in_progress", message: "This booking is ongoing (trip in progress)." });
  }

  for (const r of refunds) {
    if (["pending", "approved"].includes(low(r.status))) {
      blockers.push({ code: "refund_open", message: `A refund request (${r.status}, ${peso(r.amount)}) is still open.`, ref: r.refundRequestID || r.id });
    }
  }

  for (const p of payments) {
    // discount spill-over: cash owed back to the customer that has not been handed back yet
    if (num(p.refundDue) > 0 && !p.refundIssued) {
      blockers.push({ code: "refund_due", message: `${peso(p.refundDue)} is owed back to the customer and has not been marked as handed back.`, ref: p.paymentID || p.id });
    }
    // discount credit still held for the customer (a discount on a fully paid booking): it is owed back with the deposit
    if (num(p.discountCredit) > 0) {
      blockers.push({ code: "discount_credit_held", message: `${peso(p.discountCredit)} of discount credit is still held for the customer — return it with the security deposit first.`, ref: p.paymentID || p.id });
    }
    // the trip is over but the security deposit is still held: the customer is owed it (or it must be settled)
    if (low(p.depositStatus) === "held" && bookingStatus === "completed") {
      blockers.push({ code: "deposit_held", message: `The ${peso(p.securityDeposit)} security deposit is still held — settle or return it first.`, ref: p.paymentID || p.id });
    }
  }

  for (const pn of penalties) {
    if (low(pn.status) === "confirmed" && num(pn.paidAmount) < num(pn.amount)) {
      blockers.push({ code: "penalty_unpaid", message: `A confirmed penalty still has ${peso(num(pn.amount) - num(pn.paidAmount))} unpaid.`, ref: pn.penaltyID || pn.id });
    }
  }

  const paid = payments.filter((p) => ["paid", "approved"].includes(low(p.status)));
  if (booking && paid.length && bookingStatus === "upcoming") {
    warnings.push({ code: "paid_upcoming", message: "This booking is upcoming and already paid: archiving it removes a live reservation." });
  }
  if (booking && paid.length && bookingStatus === "cancelled" && !refunds.length) {
    warnings.push({ code: "paid_cancelled_no_refund", message: "The booking was cancelled, the customer paid, and no refund was ever opened (the money was kept)." });
  }
  if (booking && bookingStatus === "cancelled" && payments.some((p) => low(p.depositStatus) === "held")) {
    warnings.push({ code: "deposit_held_cancelled", message: "The booking was cancelled but a security deposit is still marked as held." });
  }
  return { blockers, warnings };
};

export class DeleteBlockedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DeleteBlockedError";
    this.code = "BLOCKED";
    this.details = details;   // { blockers, warnings, canForce }
  }
}

/** True only when the caller is allowed to force (canForce: Owner / Admin) AND asked to (force). */
const mayForce = ({ force = false, canForce = false } = {}) => Boolean(force && canForce);


// A Firestore batch holds at most 500 writes; stay well under it.
const BATCH_LIMIT = 450;

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
 * Fetches the refundRequest document linked to a bookingID, if one exists
 * (in any status — Pending/Approved/Refunded/Rejected/Failed). Previously
 * nothing archived or deleted this on booking deletion, so it was left
 * pointing at a booking/payment that no longer existed. Returns
 * { docRef, data } or null if this booking never had a refund request.
 */
const fetchRefundRequests = async (bookingID) => {
  // Every refund request of the booking, not just the first: a booking can have more than one (a rejected one and
  // a later one, or a staff refund), and any left behind would point at a booking that no longer exists.
  const snap = await db
    .collection("refundRequests")
    .where("bookingID", "==", bookingID)
    .get();

  return snap.docs.map((doc) => ({ docRef: doc.ref, data: doc.data() }));
};

/**
 * Fetches every penalty linked to a bookingID (a booking can have many).
 * Returns an array of { docRef, data } (may be empty).
 */
const fetchPenalties = async (bookingID) => {
  const snap = await db
    .collection("penalties")
    .where("bookingID", "==", bookingID)
    .get();

  return snap.docs.map((doc) => ({ docRef: doc.ref, data: doc.data() }));
};

// ─────────────────────────────────────────────────────────────
// Gathering what a booking owns -- one table failing must not take the whole dialog down
// ─────────────────────────────────────────────────────────────

/**
 * Reads ONE linked table. A table that has nothing for this booking (or does not exist yet) simply comes back empty.
 * A table that cannot be READ (missing index, permission, timeout ...) is recorded in `problems` instead of throwing,
 * so the preview still opens and the delete still goes ahead. It is shown as a WARNING (never a blocker): rows left in
 * that table could not be archived and stay live, pointing at a booking that no longer exists.
 */
const readTable = async (label, fn, fallback, problems) => {
  try {
    return await fn();
  } catch (error) {
    console.error(`[DELETE] could not read ${label}:`, error);
    problems.push({ table: label, reason: error?.message || "unknown error" });
    return fallback;
  }
};

const unreadableWarnings = (problems) => problems.map((p) => ({
  code: "table_unreadable",
  message: `Could not read ${p.table} (${p.reason}). Anything there linked to this booking will not be archived and stays as it is.`,
}));

/** Everything a booking owns, read table by table. Only the booking itself is mandatory (throws "not found"). */
const gatherBookingBundle = async (bookingDocID) => {
  const { docRef: bookingRef, data: bookingData } = await fetchBooking(bookingDocID);
  const bookingID = bookingData.bookingID ?? bookingDocID;
  const keys = [bookingID, bookingDocID];
  const problems = [];

  const paymentResult = await readTable("payments", () => fetchPayment(bookingID), null, problems);
  const reviewResults = await readTable("reviews", () => fetchReviews(bookingID), [], problems);
  const sessionResult = await readTable("booking sessions", () => fetchBookingSession(bookingID), null, problems);
  const refundRequestResults = await readTable("refund requests", () => fetchRefundRequests(bookingID), [], problems);
  const penaltyResults = await readTable("penalties", () => fetchPenalties(bookingID), [], problems);

  // driverAssignments / cancellationRequests / paymentEntries rows of this booking (see linkedArchives.service.js).
  // Found by every key the booking is known by; entries written without a bookingID are found through the payment id.
  const linkedRows = await readTable(
    "payment entries / driver assignments / cancellation requests",
    () => collectLinkedForBooking({
      bookingKeys: keys,
      paymentIDs: paymentResult ? [paymentResult.data.paymentID ?? paymentResult.docRef.id] : [],
    }),
    { driverAssignments: [], cancellationRequests: [], paymentEntries: [] },
    problems
  );
  // maintenance records linked to this booking (post-rental jobs). Routine maintenance has no bookingID and is not touched.
  const maintenanceRows = await readTable("maintenance", () => collectMaintenanceForBooking({ bookingKeys: keys }), [], problems);
  // vehicle inspection records (part condition + photos) of this booking: archived as one doc, files stay in Storage.
  const inspectionRows = await readTable("vehicle inspections", () => collectInspectionForBooking({ bookingKeys: keys }), [], problems);

  const guard = evaluateGuards({
    booking: bookingData,
    payments: paymentResult ? [paymentResult.data] : [],
    refunds: refundRequestResults.map((r) => ({ ...r.data, id: r.docRef.id })),
    penalties: penaltyResults.map((r) => ({ ...r.data, id: r.docRef.id })),
  });
  guard.warnings.push(...unreadableWarnings(problems));

  return {
    bookingRef, bookingData, bookingID, problems, guard,
    paymentResult, reviewResults, sessionResult, refundRequestResults, penaltyResults,
    linkedRows, maintenanceRows, inspectionRows,
  };
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
 * Writes a bookingSession archive document. GPS ping data lives in Google
 * Sheets now (not a Firestore subcollection under this session), and Sheets
 * rows are never touched by this delete — they simply keep existing under
 * their date tabs regardless of whether the booking/session gets archived,
 * so there's no GPS trail to snapshot or lose here anymore.
 * Returns the new bookingSessionArchivesID.
 */
const archiveBookingSession = async (sessionDocID, sessionData, archivedBy = "admin") => {
  const archiveRef = db.collection("bookingSessionArchives").doc(); // auto-ID

  const archiveDoc = {
    bookingSessionArchivesID : archiveRef.id,
    bookingSessionID         : sessionData.bookingSessionID ?? sessionDocID,
    originalId                : sessionDocID,
    archiveDate                : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt                  : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // ── spread all original session fields (includes archiveUrl if it was
    // ever flushed to Storage, status, geofenceAlerts, etc.) ──
    ...sessionData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] BookingSession archived → bookingSessionArchives/${archiveRef.id}`);
  return archiveRef.id;
};

/**
 * Writes a refundRequest archive document. No standalone viewer page reads
 * this collection (see models/refundArchives/refundArchives.model.js) — it
 * exists solely so a refund request tied to a deleted booking isn't lost.
 * Returns the new refundArchivesID.
 */
const archiveRefundRequest = async (refundRequestDocID, refundRequestData, archivedBy = "admin") => {
  const archiveRef = db.collection("refundArchives").doc(); // auto-ID

  const archiveDoc = {
    refundArchivesId : archiveRef.id,
    refundRequestID   : refundRequestData.refundRequestID ?? refundRequestDocID,
    originalId         : refundRequestDocID,
    archiveDate         : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt           : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // ── spread all original refund request fields ──
    ...refundRequestData,
  };
  // approvalLockedAt is a temporary 2-minute approval lock (see refundRequest.model.js), not data about the
  // refund: an archive must not carry it, or a restore would bring back a lock that blocks the request.
  delete archiveDoc.approvalLockedAt;

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] RefundRequest archived → refundArchives/${archiveRef.id}`);
  return archiveRef.id;
};

/**
 * Writes a single penalty archive document (viewer: PenaltyArchivePage).
 * Returns the new penaltyArchivesId.
 */
const archivePenalty = async (penaltyDocID, penaltyData, archivedBy = "admin") => {
  const archiveRef = db.collection("penaltyArchives").doc(); // auto-ID

  const archiveDoc = {
    penaltyArchivesId : archiveRef.id,
    penaltyID         : penaltyData.penaltyID ?? penaltyDocID,
    originalId        : penaltyDocID,
    archiveDate       : admin.firestore.FieldValue.serverTimestamp(),
    archivedAt        : admin.firestore.FieldValue.serverTimestamp(),
    archivedBy,
    // ── spread all original penalty fields ──
    ...penaltyData,
  };

  await archiveRef.set(archiveDoc);
  console.log(`[ARCHIVE] Penalty archived → penaltyArchives/${archiveRef.id}`);
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
 * @param {{force?: boolean, canForce?: boolean}} [opts] - the delete guard (above) throws DeleteBlockedError while a trip, refund,
 *        unpaid penalty or held deposit is still in flight. Only a caller allowed to (canForce: Owner / Admin) AND
 *        asking to (force) gets past it. Nothing has been written at that point.
 * @returns {object} Summary of what was archived / deleted
 */
export const deleteBookingWithCascade = async (bookingDocID, archivedBy = "admin", opts = {}) => {
  // ── 1. Fetch source documents (fail fast if booking missing; a linked table that cannot be read is reported) ──
  const {
    bookingRef, bookingData, bookingID, guard,
    paymentResult, reviewResults, sessionResult, refundRequestResults, penaltyResults,
    linkedRows, maintenanceRows, inspectionRows,
  } = await gatherBookingBundle(bookingDocID);

  console.log(
    `[DELETE] Booking ${bookingDocID} | ` +
    `payment: ${paymentResult ? "found" : "none"} | ` +
    `reviews: ${reviewResults.length} | ` +
    `session: ${sessionResult ? "found" : "none"} | ` +
    `refundRequests: ${refundRequestResults.length} | ` +
    `penalties: ${penaltyResults.length} | ` +
    `assignments: ${linkedRows.driverAssignments.length} | ` +
    `cancellationRequests: ${linkedRows.cancellationRequests.length} | ` +
    `paymentEntries: ${linkedRows.paymentEntries.length} | ` +
    `maintenance: ${maintenanceRows.length} | ` +
    `inspection: ${inspectionRows.length}`
  );

  // ── 1b. Delete guard: refuse while a trip / refund / penalty / held deposit is still in flight ─────────
  if (guard.blockers.length && !mayForce(opts)) {
    throw new DeleteBlockedError(guard.blockers[0].message, { ...guard, canForce: Boolean(opts.canForce) });
  }

  // ── 2. Archive phase (must all succeed before any delete) ─────────────────
  let bookingArchivesID;
  let paymentsArchivesID = null;
  let bookingSessionArchivesID = null;
  const refundArchivesIDs = [];
  let linkedArchivedCounts = { driverAssignments: 0, cancellationRequests: 0, paymentEntries: 0 };
  let maintenanceArchivedCount = 0;
  let inspectionArchivedCount = 0;
  const reviewsArchivesIDs = [];
  const penaltyArchivesIDs = [];

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

    // 2d. Archive bookingSession (if exists) — GPS pings live in Sheets and
    // are untouched by this delete, so there's no day-doc trail to fold in.
    if (sessionResult) {
      bookingSessionArchivesID = await archiveBookingSession(
        sessionResult.docRef.id,
        sessionResult.data,
        archivedBy
      );
    }

    // 2e. Archive refundRequest (if exists) — in any status. Closes the gap
    // where a refund request tied to this booking would otherwise be left
    // pointing at a booking/payment that no longer exists.
    for (const { docRef: refundRef, data: refundData } of refundRequestResults) {
      const id = await archiveRefundRequest(refundRef.id, refundData, archivedBy);
      refundArchivesIDs.push(id);
    }

    // 2f. Archive every penalty (if any) — a booking can have several.
    for (const { docRef: penaltyRef, data: penaltyData } of penaltyResults) {
      const id = await archivePenalty(penaltyRef.id, penaltyData, archivedBy);
      penaltyArchivesIDs.push(id);
    }

    // 2g. Archive the driver assignments, cancellation requests and payment entries (any status). They used to be
    // left live and pointing at a booking that no longer exists.
    linkedArchivedCounts = await writeLinkedArchives(linkedRows, archivedBy);

    // 2h. Archive the booking-linked maintenance records (any status).
    maintenanceArchivedCount = await writeMaintenanceArchives(maintenanceRows, archivedBy);

    // 2i. Archive the booking's vehicle inspection records (one archive doc; the photo files are not moved).
    inspectionArchivedCount = await writeInspectionArchive(inspectionRows, { bookingID, archivedBy });
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

    // 3d. Delete bookingSession. No archive/{date} subcollection lives under
    // it anymore (pings are in Sheets, untouched by this delete), so there's
    // nothing else underneath it to clean up in this batch.
    if (sessionResult) {
      batch.delete(sessionResult.docRef);
    }

    // 3e. Delete refundRequests
    for (const { docRef: refundRef } of refundRequestResults) {
      batch.delete(refundRef);
    }

    // 3f. Delete penalties
    for (const { docRef: penaltyRef } of penaltyResults) {
      batch.delete(penaltyRef);
    }

    // 3g. Delete the rows archived in 2g. They share the batch (all or nothing) while it fits; anything past the
    // limit goes in follow-up batches (their archive copies already exist, so nothing can be lost).
    let ops =
      1 + (paymentResult ? 1 : 0) + reviewResults.length + (sessionResult ? 1 : 0) +
      refundRequestResults.length + penaltyResults.length;
    const overflow = [];
    for (const ref of [...linkedLiveRefs(linkedRows), ...maintenanceLiveRefs(maintenanceRows), ...inspectionLiveRefs(inspectionRows)]) {
      if (ops < BATCH_LIMIT) { batch.delete(ref); ops += 1; } else overflow.push(ref);
    }

    await batch.commit();
    for (const part of chunk(overflow, BATCH_LIMIT)) {
      const extra = db.batch();
      part.forEach((ref) => extra.delete(ref));
      await extra.commit();
    }
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

  // The booking's inspection records and its post-rental jobs just left the live collections, which can change
  // which parts count as damaged -> bring the car parts' live condition (carParts.status) back in line.
  await syncCarPartConditions(
    bookingData.carID,
    maintenanceRows.map((d) => d.data().carID),
    inspectionRows.map((r) => r.doc.data().carID)
  );

  // ── 4. Return summary ─────────────────────────────────────────────────────
  return {
    success          : true,
    bookingDocID,
    bookingID,
    bookingArchivesID,
    paymentsArchivesID,
    bookingSessionArchivesID,
    refundArchivesID       : refundArchivesIDs[0] ?? null,   // first one, kept for older callers
    refundArchivesIDs,
    reviewsArchivesIDs,
    penaltyArchivesIDs,
    linkedArchived         : linkedArchivedCounts,
    maintenanceArchivedCount,
    inspectionArchivedCount,
    mode                  : "bundle",
    warnings              : guard.warnings,
    forced                : guard.blockers.length > 0,
    penaltiesArchivedCount : penaltyResults.length,
    reviewsArchivedCount : reviewResults.length,
    sessionArchived       : Boolean(sessionResult),
    refundRequestArchived : refundRequestResults.length > 0,
    message          :
      `Booking ${bookingDocID} and ${paymentResult ? 1 : 0} payment(s), ` +
      `${reviewResults.length} review(s), ` +
      `${sessionResult ? 1 : 0} session, ` +
      `${refundRequestResults.length} refund request(s), ` +
      `${linkedArchivedCounts.paymentEntries} payment entr${linkedArchivedCounts.paymentEntries === 1 ? "y" : "ies"}, ` +
      `${linkedArchivedCounts.driverAssignments} driver assignment(s), ` +
      `${linkedArchivedCounts.cancellationRequests} cancellation request(s), ` +
      `${maintenanceArchivedCount} maintenance record(s), ` +
      `${inspectionArchivedCount} vehicle inspection record(s), ` +
      `${penaltyResults.length} penalt${penaltyResults.length === 1 ? "y" : "ies"} archived and deleted successfully.`,
  };
};

/**
 * previewBookingDelete -- the dry run behind the "are you sure?" dialog. Collects exactly what
 * deleteBookingWithCascade would archive and runs the same guard. Writes nothing.
 */
export const previewBookingDelete = async (bookingDocID) => {
  const {
    bookingData, bookingID, guard,
    paymentResult, reviewResults, sessionResult, refundRequestResults, penaltyResults,
    linkedRows, maintenanceRows, inspectionRows,
  } = await gatherBookingBundle(bookingDocID);

  return {
    mode: "bundle",
    booking: { id: bookingDocID, bookingID, status: bookingData.status ?? null },
    counts: {
      booking: 1,
      payment: paymentResult ? 1 : 0,
      refund: refundRequestResults.length,
      penalty: penaltyResults.length,
      review: reviewResults.length,
      session: sessionResult ? 1 : 0,
      entry: linkedRows.paymentEntries.length,
      assignment: linkedRows.driverAssignments.length,
      cancellation: linkedRows.cancellationRequests.length,
      maintenance: maintenanceRows.length,
      inspection: inspectionRows.length,
    },
    // tables that were read fine but hold nothing for this booking -> the dialog says "none found" for them
    missing: [
      !paymentResult && "payment", !reviewResults.length && "reviews", !sessionResult && "trip session",
      !refundRequestResults.length && "refund requests", !penaltyResults.length && "penalties",
      !linkedRows.paymentEntries.length && "money entries", !linkedRows.driverAssignments.length && "driver assignments",
      !linkedRows.cancellationRequests.length && "cancellation records", !maintenanceRows.length && "maintenance records",
      !inspectionRows.length && "vehicle inspection records",
    ].filter(Boolean),
    ...guard,
  };
};

