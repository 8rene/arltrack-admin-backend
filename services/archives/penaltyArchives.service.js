// (live rows, or the rows archived with the booking in paymentEntryArchives).
import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserNames } from "./resolveUserName.service.js";
import { hydratePenaltiesWithArchives } from "./entryArchiveHydrate.service.js";
import { restoreEntryArchivesBy, restoreLinkedForBooking } from "./linkedArchives.service.js";
import { restoreMaintenanceArchivesForBooking } from "./maintenanceArchives.service.js";
import { stripArchiveMeta } from "./archiveMeta.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllPenaltyArchives = async () => {
  const snapshot = await db
    .collection("penaltyArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const nameMap = await resolveUserNames(snapshot.docs.map((doc) => doc.data().userID));

  // Archived penalties lose paymentMethod / referenceNumber / paidAt in the PHASE 2 cleanup too: read them back from the entries
  // (live rows, or the rows archived with the booking in paymentEntryArchives).
  const hydrated = await hydratePenaltiesWithArchives(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));

  return snapshot.docs.map((doc, idx) => {
    const { id: _docID, ...data } = hydrated[idx];
    return {
      penaltyArchivesId: doc.id,
      ...data,
      customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
      createdAt:   toISO(data.createdAt),
      updatedAt:   toISO(data.updatedAt),
      confirmedAt: toISO(data.confirmedAt ?? data.createdAt),   // not stored on new penalties: confirmed when created
      paidAt:      toISO(data.paidAt),
      archivedAt:  toISO(data.archivedAt),
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
  await activeRef.set(original);
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
  await activeRef.set(original);
  await archiveDoc.ref.delete();
  return true;
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restorePenaltyArchive = async (penaltyArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("penaltyArchives").doc(penaltyArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived penalty not found.");

  const archived = archiveDoc.data();
  const originalId = archived.originalId;
  const originalData = stripArchiveMeta(archived);

  const activeRef = originalId ? db.collection("penalties").doc(originalId) : db.collection("penalties").doc();
  await activeRef.set(originalData);

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);
  const restoredPayment = await restoreLinkedPayment(originalData.bookingID);

  // The penalty's money movements were archived with the booking (paymentEntryArchives): bring them back with it.
  // A payment that came back needs all of its rows; a booking that came back needs its driver / cancellation history.
  await restoreEntryArchivesBy("penaltyID", [originalData.penaltyID || originalId]);
  if (restoredPayment) await restoreEntryArchivesBy("paymentID", [originalData.paymentID]);
  if (restoredBooking) {
    await restoreLinkedForBooking({ bookingKeys: [originalData.bookingID], kinds: ["driverAssignments", "cancellationRequests"] });
    await restoreMaintenanceArchivesForBooking({ bookingKeys: [originalData.bookingID] });
  }

  await archiveRef.delete();
  return { restoredBooking, restoredPayment };
};

// ── BOOKING-ARCHIVE CASCADE ──────────────────────────────────────────────────
// Used by bookingArchives.service.js: restoring a booking brings every one of its archived penalties back
// (a booking can have many); permanently deleting the booking archive removes them.
export const restorePenaltyArchivesForBooking = async (bookingID) => {
  if (!bookingID) return 0;
  const snap = await db.collection("penaltyArchives").where("bookingID", "==", bookingID).get();
  for (const d of snap.docs) {
    const data = d.data();
    const batch = db.batch();
    batch.set(
      db.collection("penalties").doc(data.originalId || d.id),
      stripArchiveMeta(data)
    );
    batch.delete(d.ref);
    await batch.commit();
  }
  return snap.docs.length;
};

export const getPenaltyArchiveRefsForBooking = async (bookingID) => {
  if (!bookingID) return [];
  const snap = await db.collection("penaltyArchives").where("bookingID", "==", bookingID).get();
  return snap.docs.map((d) => d.ref);
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deletePenaltyArchive = async (penaltyArchivesId) => {
  const archiveRef = db.collection("penaltyArchives").doc(penaltyArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived penalty not found.");
  await archiveRef.delete();
};