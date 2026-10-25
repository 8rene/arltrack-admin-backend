/**
 * reviewsArchives.service.js
 *
 * CRUD operations for the reviewsArchives collection.
 * Mirrors the pattern used in bookingArchives.service.js
 * and paymentsArchives.service.js.
 */

import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserNames } from "./resolveUserName.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────
export const getAllReviewsArchives = async () => {
  const snapshot = await db
    .collection("reviewsArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      reviewsArchivesID : doc.id,
      originalId        : doc.id, // response only (the ID is no longer stored as a field)
      ...data,
      createdAt  : toISO(data.createdAt),
      updatedAt  : toISO(data.updatedAt),
      archiveDate: toISO(data.archiveDate),
      archivedAt : toISO(data.archivedAt),
    };
  });

  // Reviews store the reviewer as userID (some older rows may instead use
  // reviewerID, depending on what the customer-facing app wrote); resolve
  // whichever is present to a display name so the UI shows "who reviewed"
  // instead of a raw Firestore ID. archivedBy is already a readable
  // username/uid captured at delete time (see bookingDelete.service.js),
  // so it's returned as-is for "deleted by".
  const reviewerIDs = rows.map((r) => r.userID || r.reviewerID).filter(Boolean);
  const nameMap = await resolveUserNames(reviewerIDs);
  return rows.map((r) => {
    const reviewerID = r.userID || r.reviewerID || null;
    return { ...r, reviewerName: reviewerID ? nameMap[reviewerID] : null };
  });
};

// ── RESTORE ──────────────────────────────────────────────────
export const restoreReviewsArchive = async (reviewsArchivesID, restoredBy = "admin") => {
  const archiveRef = db.collection("reviewsArchives").doc(reviewsArchivesID);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived review not found.");

  const {
    reviewsArchivesID : _skip,
    archiveDate,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  const activeRef = db.collection("reviews").doc(archiveDoc.id); // same ID the review had

  await activeRef.set(originalData);

  // Archive doc's job is done once the review is back in the live
  // collection — delete it instead of keeping a "Restored" marker around,
  // so restored records don't linger in the archive list.
  await archiveRef.delete();
};

// ── PERMANENT DELETE ─────────────────────────────────────────
export const deleteReviewsArchive = async (reviewsArchivesID) => {
  const archiveRef = db.collection("reviewsArchives").doc(reviewsArchivesID);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived review not found.");
  await archiveRef.delete();
};