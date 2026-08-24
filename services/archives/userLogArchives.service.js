import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllUserLogArchives = async () => {
  const snapshot = await db
    .collection("userLogArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      userLogArchivesId: doc.id,
      ...data,
      loginDateTime:  toISO(data.loginDateTime),
      logoutDateTime: toISO(data.logoutDateTime),
      archivedAt:     toISO(data.archivedAt),
      restoredAt:     toISO(data.restoredAt),
    };
  });
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
// Copies record back to 'userLogs', then marks archive doc as restored.
export const restoreUserLogArchive = async (userLogArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("userLogArchives").doc(userLogArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived user log not found.");

  const {
    userLogArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  // Re-insert into active collection (use originalId as doc ID if available)
  const activeRef = originalId
    ? db.collection("userLogs").doc(originalId)
    : db.collection("userLogs").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Archive doc's job is done once the user log is back in the live
  // collection — delete it instead of keeping a "Restored" marker around.
  // (Audit trail of the restore action itself is written separately via
  // createAuditLog in the controller, so we're not losing that history.)
  await archiveRef.delete();
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deleteUserLogArchive = async (userLogArchivesId) => {
  const archiveRef = db.collection("userLogArchives").doc(userLogArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user log not found.");
  await archiveRef.delete();
};