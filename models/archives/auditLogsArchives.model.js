// Matches the 'auditLogsArchives' collection in Firestore
// Primary key: auditLogsArchivesId (Firestore document ID)
export const AuditLogsArchive = {
  auditLogsArchivesId: "",  // Firestore doc ID — same as collection name + "Id"
  originalId: "",           // doc ID from original 'auditLogs' collection
  userID: "",
  action: "",               // "REGISTER" | "LOGIN" | "LOGOUT" | "UPDATE" | "DELETE" | etc.
  description: "",
  targetCollection: "",
  targetDocId: "",
  createdAt: null,
  archivedAt: null,
  archivedBy: "",
  // Restore deletes this doc entirely (see restoreAuditLogsArchive in
  // services/archives/auditLogsArchives.service.js) rather than marking it.
  // restoredAt can still show up here though, inherited from the live
  // audit log doc if it's ever archived again after being restored.
  // restoredBy was previously written directly to this doc on restore but
  // that write path no longer exists, so it's been removed from this model.
  restoredAt: null,
};