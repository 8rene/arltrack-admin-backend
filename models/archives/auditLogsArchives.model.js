// Matches the 'auditLogsArchives' collection in Firestore
// An archive is a COPY of an auditLogs row: archiveAuditLog() in services/auditLogs/auditLogs.service.js spreads the live
// row, adds the three bookkeeping fields below, and then deletes the live row.
//
// The archive document's own ID is NOT stored on it: services/archives/auditLogsArchives.service.js adds auditLogsArchivesId
// from doc.id when it lists the archives.
export const AuditLogsArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored ----
  originalId: "",           // doc ID from original 'auditLogs' collection
  archivedAt: null,
  archivedBy: "",           // userID of the staff member who archived it
  // ---- copied from the auditLogs row (written by createAuditLog) ----
  auditLogsID: "",          // the live row's own ID
  userID: "",               // uid of the staff member who did the action (nullable)
  action: "",               // "create" | "update" | "delete" | "export" | "auth" | "system"
  description: "",
  // Optional links to what the entry is about; present only when the action had one
  bookingID: null,
  paymentID: null,
  refundRequestID: null,
  createdAt: null,
  // Restore deletes this doc entirely (see restoreAuditLogsArchive in
  // services/archives/auditLogsArchives.service.js) rather than marking it,
  // and writes no restore stamp onto the live audit log doc.
};
