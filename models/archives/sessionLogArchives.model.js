// Matches the 'sessionLogArchives' collection in Firestore.
// Primary key: sessionLogArchivesId (Firestore document ID)
// Renamed from 'userLogArchives' to match the sessionLogs rename.
export const SessionLogArchive = {
  sessionLogArchivesId: "", // Firestore doc ID — same as collection name + "Id"
  originalId: "",           // doc ID from original 'sessionLogs' collection

  uID: "",
  username: "",
  platform: "",
  status: "",
  closedReason: null,
  loginDateTime: null,
  logoutDateTime: null,
  sessionDuration: 0,
  attemptedAt: null,
  blockedReason: "",

  archivedAt: null,
  // Restore deletes this doc entirely (see restoreSessionLogArchive in
  // services/archives/sessionLogArchives.service.js) rather than marking
  // it. restoredAt can still show up here though, inherited from the live
  // session log doc if it's ever archived again after being restored.
  restoredAt: null,
};