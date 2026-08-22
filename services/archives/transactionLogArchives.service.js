import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveUserNames } from "./resolveUserName.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllTransactionLogArchives = async () => {
  const snapshot = await db
    .collection("transactionLogArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      transactionLogArchivesId: doc.id,
      ...data,
      createdAt:  toISO(data.createdAt),
      archivedAt: toISO(data.archivedAt),
      restoredAt: toISO(data.restoredAt),
    };
  });

  // transactionLogArchives stores userID per the model (see
  // models/transactionLogArchives/transactionLogArchives.model.js) but
  // nothing resolved it to a name for the admin UI — add it here.
  const nameMap = await resolveUserNames(rows.map((r) => r.userID));
  return rows.map((r) => ({ ...r, userName: r.userID ? nameMap[r.userID] : null }));
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restoreTransactionLogArchive = async (transactionLogArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("transactionLogArchives").doc(transactionLogArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived transaction log not found.");

  const {
    transactionLogArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("transactionLogs").doc(originalId)
    : db.collection("transactionLogs").doc();

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
export const deleteTransactionLogArchive = async (transactionLogArchivesId) => {
  const archiveRef = db.collection("transactionLogArchives").doc(transactionLogArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived transaction log not found.");
  await archiveRef.delete();
};