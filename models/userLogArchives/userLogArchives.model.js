// Matches the 'userLogArchives' collection in Firestore
// Primary key: userLogArchivesId (Firestore document ID)
export const UserLogArchive = {
  userLogArchivesId: "",   // Firestore doc ID — same as collection name + "Id"
  originalId: "",          // doc ID from original 'userLogs' collection
  uID: "",                 // user ID (from original userLogs)
  username: "",
  loginDateTime: null,
  logoutDateTime: null,
  sessionDuration: 0,
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
  restoredBy: null,
};
