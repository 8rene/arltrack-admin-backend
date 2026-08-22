import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllRefundArchives = async () => {
  const snapshot = await db
    .collection("refundArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      refundArchivesId: doc.id,
      ...data,
      createdAt:   toISO(data.createdAt),
      updatedAt:   toISO(data.updatedAt),
      processedAt: toISO(data.processedAt),
      archivedAt:  toISO(data.archivedAt),
      restoredAt:  toISO(data.restoredAt),
    };
  });
};

// ── HELPERS: bring the linked booking/payment back too, if still archived ──
// A refund request only ever lands in refundArchives via the booking-delete
// cascade (see services/booking/bookingDelete.service.js) — so restoring it
// on its own would leave it pointing at a bookingID/paymentID with no live
// doc, same failure mode paymentsArchives.service.js already guards
// against for its own linked booking.
const restoreLinkedBooking = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db
    .collection("bookingArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const bookingArchiveDoc = snap.docs[0];
  const {
    bookingArchivesId: _skip,
    originalId,
    archivedAt: _ba,
    archivedBy: _bab,
    restoredAt: _br,
    restoredBy: _brb,
    customerName: _bcn,
    ...bookingOriginalData
  } = bookingArchiveDoc.data();

  const bookingActiveRef = originalId
    ? db.collection("bookings").doc(originalId)
    : db.collection("bookings").doc();

  await bookingActiveRef.set({
    ...bookingOriginalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await bookingArchiveDoc.ref.delete();
  return true;
};

const restoreLinkedPayment = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db
    .collection("paymentsArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const paymentArchiveDoc = snap.docs[0];
  const {
    paymentsArchivesId: _skip,
    originalId,
    archivedAt: _pa,
    archivedBy: _pab,
    restoredAt: _pr,
    restoredBy: _prb,
    customerName: _pcn,
    ...paymentOriginalData
  } = paymentArchiveDoc.data();

  const paymentActiveRef = originalId
    ? db.collection("payments").doc(originalId)
    : db.collection("payments").doc();

  await paymentActiveRef.set({
    ...paymentOriginalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await paymentArchiveDoc.ref.delete();
  return true;
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restoreRefundArchive = async (refundArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("refundArchives").doc(refundArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived refund request not found.");

  const {
    refundArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    customerName,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("refundRequests").doc(originalId)
    : db.collection("refundRequests").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);
  const restoredPayment = await restoreLinkedPayment(originalData.bookingID);

  await archiveRef.update({
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    restoredBy,
  });

  return { restoredBooking, restoredPayment };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deleteRefundArchive = async (refundArchivesId) => {
  const archiveRef = db.collection("refundArchives").doc(refundArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived refund request not found.");
  await archiveRef.delete();
};