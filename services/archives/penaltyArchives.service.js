import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveUserNames } from "./resolveUserName.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllPenaltyArchives = async () => {
  const snapshot = await db
    .collection("penaltyArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const nameMap = await resolveUserNames(snapshot.docs.map((doc) => doc.data().userID));

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      penaltyArchivesId: doc.id,
      ...data,
      customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
      createdAt:   toISO(data.createdAt),
      updatedAt:   toISO(data.updatedAt),
      confirmedAt: toISO(data.confirmedAt),
      paidAt:      toISO(data.paidAt),
      archivedAt:  toISO(data.archivedAt),
      restoredAt:  toISO(data.restoredAt),
    };
  });
};

// ── HELPERS: bring the linked booking/payment back too, if still archived ──
// Same reasoning as refundArchives.service.js — a penalty only lands here
// through the booking-delete cascade, so restoring it alone would leave it
// pointing at a bookingID/paymentID with no live doc.
const restoreLinkedBooking = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db.collection("bookingArchives").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) return false;

  const archiveDoc = snap.docs[0];
  const {
    bookingArchivesID: _id, bookingArchivesId: _id2, originalId,
    archiveDate: _ad, archivedAt: _a, archivedBy: _ab,
    restoredAt: _r, restoredBy: _rb, customerName: _cn,
    ...original
  } = archiveDoc.data();

  const activeRef = originalId ? db.collection("bookings").doc(originalId) : db.collection("bookings").doc();
  await activeRef.set({ ...original, restoredAt: admin.firestore.FieldValue.serverTimestamp() });
  await archiveDoc.ref.delete();
  return true;
};

const restoreLinkedPayment = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db.collection("paymentsArchives").where("bookingID", "==", bookingID).limit(1).get();
  if (snap.empty) return false;

  const archiveDoc = snap.docs[0];
  const {
    paymentsArchivesID: _id, paymentsArchivesId: _id2, originalId,
    archiveDate: _ad, archivedAt: _a, archivedBy: _ab,
    restoredAt: _r, restoredBy: _rb, customerName: _cn,
    ...original
  } = archiveDoc.data();

  const activeRef = originalId ? db.collection("payments").doc(originalId) : db.collection("payments").doc();
  await activeRef.set({ ...original, restoredAt: admin.firestore.FieldValue.serverTimestamp() });
  await archiveDoc.ref.delete();
  return true;
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restorePenaltyArchive = async (penaltyArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("penaltyArchives").doc(penaltyArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived penalty not found.");

  const {
    penaltyArchivesId: _skip, originalId,
    archiveDate: _ad, archivedAt, archivedBy,
    restoredAt, restoredBy: _rb, customerName,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId ? db.collection("penalties").doc(originalId) : db.collection("penalties").doc();
  await activeRef.set({ ...originalData, restoredAt: admin.firestore.FieldValue.serverTimestamp() });

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);
  const restoredPayment = await restoreLinkedPayment(originalData.bookingID);

  await archiveRef.delete();
  return { restoredBooking, restoredPayment };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deletePenaltyArchive = async (penaltyArchivesId) => {
  const archiveRef = db.collection("penaltyArchives").doc(penaltyArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived penalty not found.");
  await archiveRef.delete();
};