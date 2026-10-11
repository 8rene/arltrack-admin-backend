import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { findLinkedBookingSessionArchive } from "./bookingSessionArchives.service.js";
import { resolveUserNames } from "./resolveUserName.service.js";
import { getAssignmentRefsForBooking } from "../driverAssignments/driverAssignments.service.js";
import { getRequestRefsForBooking } from "../cancellationRequests/cancellationRequests.service.js";
import { getEntryRefsForBooking } from "../paymentEntries/paymentEntries.service.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { restoreLinkedForBooking, getLinkedArchiveRefsForBooking } from "./linkedArchives.service.js";
import {
  restoreInspectionArchiveForBooking,
  getInspectionArchiveSnapsForBooking,
  getArchivedInspectionForBooking,
  inspectionFileUrls,
  removeInspectionFiles,
} from "./vehicleInspectionArchives.service.js";
import { restoreMaintenanceArchivesForBooking, getMaintenanceArchiveRefsForBooking } from "./maintenanceArchives.service.js";
import { restorePenaltyArchivesForBooking, getPenaltyArchiveRefsForBooking } from "./penaltyArchives.service.js";
import { restoreRefundArchivesForBooking, getRefundArchiveRefsForBooking } from "./refundArchives.service.js";

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

// Vehicle Inspection records (damage/parts status + photo links) are archived with the booking into ONE
// vehicleInspectionArchives doc (services/archives/vehicleInspectionArchives.service.js). Bookings archived BEFORE
// that existed still have their records in these four live collections, so this list is kept for them: it feeds
// (a) the "View Vehicle Inspection" modal on the Booking Archive page (archive doc first, live as fallback) and
// (b) the permanent-delete cascade below, which cleans up either form.
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
  const archived = bookingID ? await getArchivedInspectionForBooking(bookingID) : null;
  if (archived) return archived;
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
// 3b. Restore the booking's penaltyArchives / refundArchives, and its driverAssignmentArchives,
//     cancellationRequestArchives, paymentEntryArchives and maintenanceArchives, into their live collections
// 4. Delete all the archive records (booking, payment, reviews, session ...)
export const restoreBookingArchive = async (bookingArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("bookingArchives").doc(bookingArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking not found.");

  const archived1 = archiveDoc.data();
  const originalId = archived1.originalId;
  const originalData = stripArchiveMeta(archived1);

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
    const archived2 = paymentArchiveDoc.data();
    const payOriginalId = archived2.originalId;
    const payOriginalData = stripArchiveMeta(archived2);

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

  // ── 3b. Restore the linked penalties, refund requests, driver assignments, cancellation requests and
  // payment entries. Each restore moves its rows back and deletes their archive copies in the same batch.
  // Rows are found under every key the booking is known by (bookingID field and Firestore doc id); entries
  // written without a bookingID are found through the payment id. ──
  const restoredPenalties = await restorePenaltyArchivesForBooking(bookingID);
  const restoredRefunds   = await restoreRefundArchivesForBooking(bookingID);
  const paymentArchiveData = paymentArchiveDoc ? paymentArchiveDoc.data() : null;
  const linkedRestored = await restoreLinkedForBooking({
    bookingKeys: [bookingID, originalId],
    paymentIDs: paymentArchiveData ? [paymentArchiveData.paymentID ?? paymentArchiveData.originalId] : [],
  });
  const restoredMaintenance = await restoreMaintenanceArchivesForBooking({ bookingKeys: [bookingID, originalId] });
  const restoredInspection = await restoreInspectionArchiveForBooking({ bookingKeys: [bookingID, originalId] });

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
    restoredPenalties,
    restoredRefunds,
    restoredDriverAssignments:    linkedRestored.driverAssignments,
    restoredCancellationRequests: linkedRestored.cancellationRequests,
    restoredPaymentEntries:       linkedRestored.paymentEntries,
    restoredMaintenance,
    restoredInspection,
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
  // Bookings archived since the three collections got their own archives keep those rows in
  // driverAssignmentArchives / cancellationRequestArchives / paymentEntryArchives (and the penalty and refund
  // archives); the live-row cleanup above only covers bookings archived before that.
  const paymentID          = paymentArchiveDoc ? (paymentArchiveDoc.data().paymentID ?? paymentArchiveDoc.data().originalId) : null;
  const linkedArchiveRefs  = await getLinkedArchiveRefsForBooking({
    bookingKeys: [bookingID, data.originalId],
    paymentIDs: paymentID ? [paymentID] : [],
  });
  const penaltyArchiveRefs = await getPenaltyArchiveRefsForBooking(bookingID);
  const refundArchiveRefs  = await getRefundArchiveRefsForBooking(bookingID);
  const maintenanceArchiveRefs = await getMaintenanceArchiveRefsForBooking({ bookingKeys: [bookingID, data.originalId] });
  // vehicle inspection archive (new) + the Storage files (photos, GPS history JSON) behind every record that goes
  const inspectionArchiveSnaps = await getInspectionArchiveSnapsForBooking({ bookingKeys: [bookingID, data.originalId] });
  const fileUrls = inspectionFileUrls({ archiveSnaps: inspectionArchiveSnaps, liveDocs: inspectionDocs });
  if (sessionArchiveDoc?.data().archiveUrl) fileUrls.add(sessionArchiveDoc.data().archiveUrl);

  // Delete everything that hangs off the booking archive first, in chunks of 450 (a Firestore batch takes at most 500
  // writes), and the booking archive itself LAST: if a chunk fails the booking archive is still there, so the same
  // permanent delete can simply be run again.
  const refs = [];
  if (paymentArchiveDoc) refs.push(paymentArchiveDoc.ref);
  for (const reviewDoc of reviewArchiveDocs) refs.push(reviewDoc.ref);
  if (sessionArchiveDoc) refs.push(sessionArchiveDoc.ref);
  for (const inspectionDoc of inspectionDocs) refs.push(inspectionDoc.ref);
  refs.push(...inspectionArchiveSnaps.map((s) => s.ref), ...assignmentRefs, ...requestRefs, ...entryRefs, ...linkedArchiveRefs, ...penaltyArchiveRefs, ...refundArchiveRefs, ...maintenanceArchiveRefs);

  const uniqueRefs = [...new Map(refs.map((r) => [r.path, r])).values()];
  for (let i = 0; i < uniqueRefs.length; i += 450) {
    const batch = db.batch();
    uniqueRefs.slice(i, i + 450).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  await archiveRef.delete();

  // Last of all: the files. Only now is nothing left that could be restored and would still need them.
  const files = await removeInspectionFiles(fileUrls);

  return {
    deletedPaymentArchive: !!paymentArchiveDoc,
    deletedReviewArchives: reviewArchiveDocs.length,
    deletedSessionArchive: !!sessionArchiveDoc,
    deletedInspectionDocs: inspectionDocs.length,
    deletedAssignments:    assignmentRefs.length,
    deletedCancellationRequests: requestRefs.length,
    deletedPaymentEntries: entryRefs.length,
    deletedLinkedArchives: linkedArchiveRefs.length,
    deletedPenaltyArchives: penaltyArchiveRefs.length,
    deletedRefundArchives: refundArchiveRefs.length,
    deletedMaintenanceArchives: maintenanceArchiveRefs.length,
    deletedInspectionArchives: inspectionArchiveSnaps.length,
    deletedFiles: files.deleted,
    failedFiles: files.failed,
  };
};