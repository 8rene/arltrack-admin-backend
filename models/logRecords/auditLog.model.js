// auditLogs/{auditLogsID}   -- who did what in the admin
// Written by createAuditLog() / auditSafe() in services/auditLogs/auditLogs.service.js. Archiving a log copies it into
// auditLogsArchives (models/archives/auditLogsArchives.model.js) and deletes the live row.
export const AuditLog = {
  auditLogsID: "",       // same as the Firestore doc ID, written in the same operation
  action: "",            // "create" | "update" | "delete" | "export" | "auth" | "system"
  description: "",
  userID: null,          // uid of the staff member who did it (null for system actions)
  // Optional links to what the entry is about; present only when the action had one
  bookingID: null,
  paymentID: null,
  refundRequestID: null,
  createdAt: null,
};
