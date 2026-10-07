import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { findLinkedBookingSessionArchive } from "./bookingSessionArchives.service.js";
import { resolveUserNames } from "./resolveUserName.service.js";
import { getAssignmentRefsForBooking } from "../driverAssignments/driverAssignments.service.js";
import { getRequestRefsForBooking } from "../cancellationRequests/cancellationRequests.service.js";
import { getEntryRefsForBooking } from "../paymentEntries/paymentEntries.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllBookingArchives = async () => {
  const snapshot = await db
    .collection("bookingArchives")
    .orderBy("archivedAt", "desc")
    .get();

  // Resolve customerName once for the whole page, same pattern as the
  // other archive list endpoints — bookingArchives stores userID directly
  // so no booking lookup is needed here (unlike paymentsArchives).
  const nameMap = await resolveUserNames(snapshot.docs.map((doc) => doc.data().userID));

  // For each booking archive, fetch the linked payment archive amount
  const results = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const bookingID = data.bookingID ?? doc.id;

      // Look up the linked payment archive for the actual amount.
      // (bookingArchives no longer stores its own totalFee — the payment
      // archive's `amount` is the real source, looked up below.)
      let paymentAmount = null;
      try {
        const paySnap = await db
          .collection("paymentsArchives")
          .where("bookingID", "==", bookingID)
          .limit(1)
          .get();
        if (!paySnap.empty) {
          const payData = paySnap.docs[0].data();
          paymentAmount = payData.amount ?? payData.rentalFee ?? paymentAmount;
        }
      } catch (_) {}

      return {
        bookingArchivesId: doc.id,
        ...data,
        customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
        amount: paymentAmount,
        startDateTime: toISO(data.startDateTime),
        endDateTime:   toISO(data.endDateTime),
        createdAt:     toISO(data.createdAt),
        archivedAt:    toISO(data.archivedAt),
        restoredAt:    toISO(data.restoredAt),
      };
    })
  );

  return results;
};

// ── HELPERS: find linked archive docs by bookingID ────────────────────────────
const findLinkedPaymentArchive = async (bookingID) => {
  if (!bookingID) return null;
  const snap = await db
    .collection("paymentsArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0];
};

const findLinkedReviewArchives = async (bookingID) => {
  if (!bookingID) return [];
  const snap = await db
    .collection("reviewsArchives")
    .where("bookingID", "==", bookingID)
    .get();
  return snap.docs;
};

// Vehicle Inspection records (damage/parts status + photos) are NEVER
// archived — they live permanently in these four live collections, keyed
// by bookingID, regardless of what happens to the booking itself. Used by
// (a) the "View Vehicle Inspection" modal on the Booking Archive page, and
// (b) the permanent-delete cascade below, so these don't get orphaned
// forever once nothing points back to their bookingID anymore.
const INSPECTION_COLLECTIONS = [
  "inventoryBeforeTrip",
  "inventoryAfterTrip",
  "vehicleDocumentationBeforeTrip",
  "vehicleDocumentationAfterTrip",
];

export const findLinkedInspectionDocs = async (bookingID) => {
  if (!bookingID) return [];
  const snaps = await Promise.all(
    INSPECTION_COLLECTIONS.map((name) =>
      db.collection(name).where("bookingID", "==", bookingID).get()
    )
  );
  return snaps.flatMap((snap) => snap.docs);
};

// Same data as findLinkedInspectionDocs, but shaped for direct display
// (grouped by collection, timestamps normalized) rather than for deletion.
export const getInspectionRecordsForBooking = async (bookingID) => {
  if (!bookingID) return { inventoryBeforeTrip: [], inventoryAfterTrip: [], vehicleDocumentationBeforeTrip: [], vehicleDocumentationAfterTrip: [] };
  const snaps = await Promise.all(
    INSPECTION_COLLECTIONS.map((name) =>
      db.collection(name).where("bookingID", "==", bookingID).get()
    )
  );
  const result = {};
  INSPECTION_COLLECTIONS.forEach((name, i) => {
    result[name] = snaps[i].docs.map((d) => ({
      id: d.id,
      ...d.data(),
      createdAt: toISO(d.data().createdAt),
    }));
  });
  return result;
};

// ── RESTORE (cascade) ─────────────────────────────────────────────────────────
// 1. Restore booking → bookings collection
// 2. Restore linked paymentsArchives entry → payments collection (if found)
// 3. Restore linked reviewsArchives entries → reviews collection (if any)
// 4. Delete all three archive records (booking, payment, reviews)
export const restoreBookingArchive = async (bookingArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("bookingArchives").doc(bookingArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking not found.");

  const {
    bookingArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    customerName, // resolved field — not in original schema
    ...originalData
  } = archiveDoc.data();

  const bookingID = originalData.bookingID ?? originalId;

  // ── 1. Restore booking ──
  const bookingActiveRef = originalId
    ? db.collection("bookings").doc(originalId)
    : db.collection("bookings").doc();

  await bookingActiveRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 2. Find and restore linked payment archive ──
  const paymentArchiveDoc = await findLinkedPaymentArchive(bookingID);
  // ── 2b. Find linked bookingSessionArchive — restored via its own
  // recreation logic below (recreates archive/{date} day-docs too, which
  // this file has no reason to duplicate) ──
  const sessionArchiveDoc = await findLinkedBookingSessionArchive(bookingID);
  if (paymentArchiveDoc) {
    const {
      paymentsArchivesId: _ps,
      paymentsArchivesID: _psi,
      originalId: payOriginalId,
      archivedAt: _pa,
      archivedBy: _pab,
      restoredAt: _pr,
      restoredBy: _prb,
      customerName: _pcn,
      ...payOriginalData
    } = paymentArchiveDoc.data();

    const paymentActiveRef = payOriginalId
      ? db.collection("payments").doc(payOriginalId)
      : db.collection("payments").doc();

    await paymentActiveRef.set({
      ...payOriginalData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 2c. Restore linked bookingSession ──
  // GPS pings live in Sheets now, not a subcollection under this doc — Sheets
  // rows were never touched by the archive/delete, so there's no day-doc
  // trail to recreate here anymore, just the session doc itself.
  if (sessionArchiveDoc) {
    const {
      bookingSessionArchivesId: _bsaId,
      originalId: sessionOriginalId,
      archiveDate: _sad,
      archivedAt: _saa,
      archivedBy: _sab,
      restoredAt: _sar,
      restoredBy: _sarb,
      ...sessionOriginalData
    } = sessionArchiveDoc.data();

    const sessionActiveRef = sessionOriginalId
      ? db.collection("bookingSessions").doc(sessionOriginalId)
      : db.collection("bookingSessions").doc();

    await sessionActiveRef.set({
      ...sessionOriginalData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 3. Find and restore linked reviews archives ──
  const reviewArchiveDocs = await findLinkedReviewArchives(bookingID);
  for (const reviewDoc of reviewArchiveDocs) {
    const {
      reviewsArchivesID: _ri,
      originalId: revOriginalId,
      archiveDate: _rad,
      archivedAt: _ra,
      archivedBy: _rab,
      restoredAt: _rr,
      restoredBy: _rrb,
      ...reviewOriginalData
    } = reviewDoc.data();

    const reviewActiveRef = revOriginalId
      ? db.collection("reviews").doc(revOriginalId)
      : db.collection("reviews").doc();

    await reviewActiveRef.set({
      ...reviewOriginalData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 4. Delete all archive records (batch) ──
  const batch = db.batch();
  batch.delete(archiveRef); // booking archive

  if (paymentArchiveDoc) {
    batch.delete(paymentArchiveDoc.ref); // payment archive
  }
  for (const reviewDoc of reviewArchiveDocs) {
    batch.delete(reviewDoc.ref); // each review archive
  }
  if (sessionArchiveDoc) {
    batch.delete(sessionArchiveDoc.ref); // bookingSession archive
  }

  await batch.commit();

  return {
    restoredPayment: !!paymentArchiveDoc,
    restoredReviews: reviewArchiveDocs.length,
    restoredSession: !!sessionArchiveDoc,
  };
};

// ── PERMANENT DELETE (cascade) ────────────────────────────────────────────────
// Deletes the bookingArchive + its linked paymentsArchives + reviewsArchives
export const deleteBookingArchive = async (bookingArchivesId) => {
  const archiveRef = db.collection("bookingArchives").doc(bookingArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking not found.");

  const data = archiveDoc.data();
  const bookingID = data.bookingID ?? data.originalId;

  // Find linked archives
  const paymentArchiveDoc  = await findLinkedPaymentArchive(bookingID);
  const reviewArchiveDocs  = await findLinkedReviewArchives(bookingID);
  const sessionArchiveDoc  = await findLinkedBookingSessionArchive(bookingID);
  // Inspection records were never archived in the first place (they live
  // permanently in their own collections) — so a permanent delete here is
  // the only place that ever cleans them up. Without this, they'd be
  // orphaned forever: no booking, live or archived, left pointing to them.
  const inspectionDocs     = await findLinkedInspectionDocs(bookingID);
  // driverAssignments / cancellationRequests rows are NOT archived with the booking —
  // they stay in their live tables (keyed by bookingID) so a restore reconnects the
  // driver and request history automatically. This permanent delete is the only
  // place they are cleaned up.
  const assignmentRefs     = await getAssignmentRefsForBooking(bookingID);
  const requestRefs        = await getRequestRefsForBooking(bookingID);
  // paymentEntries rows are not archived either (live, keyed by bookingID / paymentID), so a restore
  // reconnects the money history. This permanent delete is the only place they are cleaned up.
  const entryRefs          = await getEntryRefsForBooking(bookingID);

  // Delete all in batch
  const batch = db.batch();
  batch.delete(archiveRef);

  if (paymentArchiveDoc) {
    batch.delete(paymentArchiveDoc.ref);
  }
  for (const reviewDoc of reviewArchiveDocs) {
    batch.delete(reviewDoc.ref);
  }
  if (sessionArchiveDoc) {
    batch.delete(sessionArchiveDoc.ref);
  }
  for (const inspectionDoc of inspectionDocs) {
    batch.delete(inspectionDoc.ref);
  }
  for (const ref of assignmentRefs) batch.delete(ref);
  for (const ref of requestRefs)    batch.delete(ref);
  for (const ref of entryRefs)      batch.delete(ref);

  await batch.commit();

  return {
    deletedPaymentArchive: !!paymentArchiveDoc,
    deletedReviewArchives: reviewArchiveDocs.length,
    deletedSessionArchive: !!sessionArchiveDoc,
    deletedInspectionDocs: inspectionDocs.length,
    deletedAssignments:    assignmentRefs.length,
    deletedCancellationRequests: requestRefs.length,
    deletedPaymentEntries: entryRefs.length,
  };
};