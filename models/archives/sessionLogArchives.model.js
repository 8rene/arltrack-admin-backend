// Matches the 'sessionLogArchives' collection in Firestore.
//
// An archive is a COPY of a sessionLogs row (see models/logs/sessionLogs.model.js -- keep the two in step). It is made by
// archiveSessionLog() in services/sessionLogs/sessionLogs.service.js, which spreads the live row, adds originalId and archivedAt,
// and then deletes the live row.
//
// The archive document's own id is NOT stored on it: services/archives/sessionLogArchives.service.js adds sessionLogArchivesId
// from doc.id when it lists the archives. Unlike most archive models this one has no archiveDate and no archivedBy.
//
// Restore writes the row back into `sessionLogs` under originalId and deletes this document (no restore stamp on the live row).
export const SessionLogArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored ----
  originalId: "",          // doc ID of the original 'sessionLogs' document, reused on restore
  archivedAt: null,

  // ---- copied from the sessionLogs document (see sessionLogs.model.js) ----
  sessionLogsID: "",
  uID: null,               // userID that logged in; null on a blocked attempt by an unknown user
  username: "",
  platform: "",            // "admin_web" | "customer_web"
  status: "",              // "active" | "logged_out" | "blocked" -- as it was when archived
  closedReason: null,      // "manual" | "revoked"; null while open
  loginDateTime: null,
  logoutDateTime: null,
  sessionDuration: 0,      // seconds
  attemptedAt: null,       // blocked attempts only
  blockedReason: "",
};