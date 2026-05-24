import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllPaymentsArchives = async () => {
  const snapshot = await db
    .collection("paymentsArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      paymentsArchivesId: doc.id,
      ...data,
      createdAt:  toISO(data.createdAt),
      updatedAt:  toISO(data.updatedAt),
      archivedAt: toISO(data.archivedAt),
      restoredAt: toISO(data.restoredAt),
    };
  });
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restorePaymentsArchive = async (paymentsArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("paymentsArchives").doc(paymentsArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived payment not found.");

  const {
    paymentsArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    customerName,          // resolved field — not part of original payments schema
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("payments").doc(originalId)
    : db.collection("payments").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await archiveRef.update({
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    restoredBy,
  });
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deletePaymentsArchive = async (paymentsArchivesId) => {
  const archiveRef = db.collection("paymentsArchives").doc(paymentsArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived payment not found.");
  await archiveRef.delete();
};
