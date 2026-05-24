import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllBookingArchives = async () => {
  const snapshot = await db
    .collection("bookingArchives")
    .orderBy("archivedAt", "desc")
    .get();

  // For each booking archive, fetch the linked payment archive amount
  const results = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const bookingID = data.bookingID ?? doc.id;

      // Look up the linked payment archive for the actual amount
      let paymentAmount = data.totalFee ?? null;
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

  await batch.commit();

  return {
    restoredPayment: !!paymentArchiveDoc,
    restoredReviews: reviewArchiveDocs.length,
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

  // Delete all in batch
  const batch = db.batch();
  batch.delete(archiveRef);

  if (paymentArchiveDoc) {
    batch.delete(paymentArchiveDoc.ref);
  }
  for (const reviewDoc of reviewArchiveDocs) {
    batch.delete(reviewDoc.ref);
  }

  await batch.commit();

  return {
    deletedPaymentArchive: !!paymentArchiveDoc,
    deletedReviewArchives: reviewArchiveDocs.length,
  };
};
