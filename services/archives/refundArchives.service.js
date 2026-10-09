import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveUserNames } from "./resolveUserName.service.js";
import { hydrateRefundRequests } from "../paymentEntries/paymentEntries.service.js";
import { stripArchiveMeta } from "./archiveMeta.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllRefundArchives = async () => {
  const snapshot = await db
    .collection("refundArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const nameMap = await resolveUserNames(snapshot.docs.map((doc) => doc.data().userID));

  // Refund docs no longer store parts[] / manualRefund / unrefundable[] -- those live in the
  // paymentEntries "out" rows (keyed by refundRequestID, which the archive copy carries).
  // paymentEntries rows are not archived with the booking, so they can still be read here.
  const hydrated = await hydrateRefundRequests(
    snapshot.docs.map((doc) => {
      const data = doc.data();
      return { ...data, refundRequestID: data.refundRequestID || data.originalId || doc.id };
    })
  );

  return snapshot.docs.map((doc, i) => {
    const data = hydrated[i];
    return {
      refundArchivesId: doc.id,
      ...data,
      customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
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
  const archived1 = bookingArchiveDoc.data();
  const originalId = archived1.originalId;
  const bookingOriginalData = stripArchiveMeta(archived1);

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
  const archived2 = paymentArchiveDoc.data();
  const originalId = archived2.originalId;
  const paymentOriginalData = stripArchiveMeta(archived2);

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

  const archived3 = archiveDoc.data();
  const originalId = archived3.originalId;
  const originalData = stripArchiveMeta(archived3);

  const activeRef = originalId
    ? db.collection("refundRequests").doc(originalId)
    : db.collection("refundRequests").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);
  const restoredPayment = await restoreLinkedPayment(originalData.bookingID);

  // Archive doc's job is done once the refund request is back in the live
  // collection — delete it instead of keeping a "Restored" marker around.
  await archiveRef.delete();

  return { restoredBooking, restoredPayment };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deleteRefundArchive = async (refundArchivesId) => {
  const archiveRef = db.collection("refundArchives").doc(refundArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived refund request not found.");
  await archiveRef.delete();
};