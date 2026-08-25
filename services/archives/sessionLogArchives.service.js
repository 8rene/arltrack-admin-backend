import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllSessionLogArchives = async () => {
  const snapshot = await db
    .collection("sessionLogArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      sessionLogArchivesId: doc.id,
      ...data,
      loginDateTime:  toISO(data.loginDateTime),
      logoutDateTime: toISO(data.logoutDateTime),
      attemptedAt:    toISO(data.attemptedAt),
      archivedAt:     toISO(data.archivedAt),
      restoredAt:     toISO(data.restoredAt),
    };
  });
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
// Copies record back to 'sessionLogs', then deletes the archive doc.
export const restoreSessionLogArchive = async (sessionLogArchivesId) => {
  const archiveRef = db.collection("sessionLogArchives").doc(sessionLogArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived session log not found.");

  const {
    sessionLogArchivesId: _skip,
    originalId,
    archivedAt,
    restoredAt,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("sessionLogs").doc(originalId)
    : db.collection("sessionLogs").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Archive doc's job is done once the session log is back in the live
  // collection — delete it instead of keeping a "Restored" marker around.
  // (Audit trail of the restore action itself is written separately via
  // createAuditLog in the controller, so we're not losing that history.)
  await archiveRef.delete();
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deleteSessionLogArchive = async (sessionLogArchivesId) => {
  const archiveRef = db.collection("sessionLogArchives").doc(sessionLogArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived session log not found.");
  await archiveRef.delete();
};