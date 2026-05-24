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
  restoredAt: null,
  restoredBy: null,
};
