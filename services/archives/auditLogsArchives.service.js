import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveUserNames } from "./resolveUserName.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllAuditLogsArchives = async () => {
  const snapshot = await db
    .collection("auditLogsArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      auditLogsArchivesId: doc.id,
      ...data,
      createdAt:  toISO(data.createdAt),
      archivedAt: toISO(data.archivedAt),
      restoredAt: toISO(data.restoredAt),
    };
  });

  // The live Audit Log page (AuditLog.jsx) resolves userID -> a name for
  // display; the archive was showing the raw ID instead. Resolve it here
  // once for the whole page so the two views stay consistent.
  const nameMap = await resolveUserNames(rows.map((r) => r.userID));
  return rows.map((r) => ({ ...r, userName: r.userID ? nameMap[r.userID] : null }));
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restoreAuditLogsArchive = async (auditLogsArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("auditLogsArchives").doc(auditLogsArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived audit log not found.");

  const {
    auditLogsArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("auditLogs").doc(originalId)
    : db.collection("auditLogs").doc();

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
export const deleteAuditLogsArchive = async (auditLogsArchivesId) => {
  const archiveRef = db.collection("auditLogsArchives").doc(auditLogsArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived audit log not found.");
  await archiveRef.delete();
};