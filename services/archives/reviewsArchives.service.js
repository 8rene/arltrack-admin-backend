/**
 * reviewsArchives.service.js
 *
 * CRUD operations for the reviewsArchives collection.
 * Mirrors the pattern used in bookingArchives.service.js
 * and paymentsArchives.service.js.
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────
export const getAllReviewsArchives = async () => {
  const snapshot = await db
    .collection("reviewsArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      reviewsArchivesID : doc.id,
      ...data,
      createdAt  : toISO(data.createdAt),
      updatedAt  : toISO(data.updatedAt),
      archiveDate: toISO(data.archiveDate),
      archivedAt : toISO(data.archivedAt),
      restoredAt : toISO(data.restoredAt),
    };
  });
};

// ── RESTORE ──────────────────────────────────────────────────
export const restoreReviewsArchive = async (reviewsArchivesID, restoredBy = "admin") => {
  const archiveRef = db.collection("reviewsArchives").doc(reviewsArchivesID);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived review not found.");

  const {
    reviewsArchivesID : _skip,
    originalId,
    archiveDate,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("reviews").doc(originalId)
    : db.collection("reviews").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await archiveRef.update({
    restoredAt : admin.firestore.FieldValue.serverTimestamp(),
    restoredBy,
  });
};

// ── PERMANENT DELETE ─────────────────────────────────────────
export const deleteReviewsArchive = async (reviewsArchivesID) => {
  const archiveRef = db.collection("reviewsArchives").doc(reviewsArchivesID);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived review not found.");
  await archiveRef.delete();
};
