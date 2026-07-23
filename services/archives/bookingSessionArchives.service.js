import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ───────────────────────────────────
export const getAllBookingSessionArchives = async () => {
  const snapshot = await db
    .collection("bookingSessionArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      bookingSessionArchivesId: doc.id,
      ...data,
      createdAt:      toISO(data.createdAt),
      archiveDate:    toISO(data.archiveDate),
      archivedAt:     toISO(data.archivedAt),
      restoredAt:     toISO(data.restoredAt),
      lastArchivedAt: toISO(data.lastArchivedAt),
    };
  });
};

// ── HELPER: find the linked archive doc by bookingID — mirrors
// findLinkedPaymentArchive/findLinkedReviewArchives in bookingArchives.service.js ──
export const findLinkedBookingSessionArchive = async (bookingID) => {
  if (!bookingID) return null;
  const snap = await db
    .collection("bookingSessionArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0];
};

// ── RESTORE ────────────────────────────────
// 1. Restore the session doc → bookingSessions
// 2. Delete the bookingSessionArchives record
// GPS pings live in Google Sheets now, not a Firestore subcollection under
// this session — Sheets rows were never touched by the archive/delete in
// the first place, so restoring the session doc is the whole job; Traceback
// and History immediately work again against whatever's still in Sheets for
// this car/date range, no day-doc recreation needed.
// Standalone — can be called directly (its own restore endpoint), or from
// bookingArchives.service.js's restoreBookingArchive as part of a full
// booking restore. Does NOT touch bookings/payments/reviews itself.
export const restoreBookingSessionArchive = async (bookingSessionArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("bookingSessionArchives").doc(bookingSessionArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking session not found.");

  const {
    bookingSessionArchivesId: _skip,
    originalId,
    archiveDate: _ad,
    archivedAt: _aa,
    archivedBy: _ab,
    restoredAt: _ra,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  // ── 1. Restore the session doc ──
  const sessionActiveRef = originalId
    ? db.collection("bookingSessions").doc(originalId)
    : db.collection("bookingSessions").doc();

  await sessionActiveRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 2. Delete the archive record ──
  await archiveRef.delete();

  return { restored: true };
};

// ── PERMANENT DELETE ───────────────────────────────
export const deleteBookingSessionArchive = async (bookingSessionArchivesId) => {
  const archiveRef = db.collection("bookingSessionArchives").doc(bookingSessionArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking session not found.");

  await archiveRef.delete();
  return { deleted: true };
};