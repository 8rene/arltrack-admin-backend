// Matches the 'userArchives' collection in Firestore.
// Primary key: userArchivesId (Firestore document ID)
//
// Written from controllers/user/user.controller.js's deleteUser(), which
// spreads the live 'user' doc's fields (see models/user/user.model.js) plus
// originalId/archivedAt.
//
// A deleted user's userDetails/userAddress/userDocument are deliberately
// NOT archived (or touched at all) here — they're left live and linked by
// userID for as long as this record sits in userArchives. Two things make
// that safe: (1) nothing in the app reads them without either a legitimate
// userID already in hand (from a booking/payment/refund) or a scoped,
// authenticated lookup, and (2)
// services/profileRequests/profileRequests.service.js's requireLiveUser()
// check stops a stale pending edit/ID-resubmit request from resurrecting
// them for an account that's already gone.
//
// The actual purge of userDetails/userAddress/userDocument happens in
// deleteUserArchive() (services/archives/userArchives.service.js) — that's
// the real point of no return for a deleted account, not this soft-delete
// step.
//
// NOTE: restore deletes this doc — see restoreUserArchive in
// services/archives/userArchives.service.js — rather than marking
// restoredAt/restoredBy, matching bookingArchives and
// bookingSessionArchives. Restoring a user does NOT recreate their Firebase
// Auth account (Auth deletion can't be undone via the Admin SDK the same
// way Firestore docs can) — authRestoreRequired on the restore response
// flags that a customer will need to sign up again, or an admin manually
// recreates the Auth account with the same uid, before they can log in.
//
// restoredAt can still show up here, though: restoring stamps restoredAt
// onto the *live* user doc, and if that user is deleted (archived) again
// later, the archive-write spreads the live doc's fields (including that
// restoredAt) straight into the new archive doc. restoredBy was previously
// written directly onto the archive doc on restore, but that write path no
// longer exists — it's fully dead, so it's been left out of this model.
export const UserArchive = {
  userArchivesId: "",  // Firestore doc ID — same as collection name + "Id"
  originalId: "",       // uid from the original 'user' collection
  createdAt: null,
  email: "",
  isVerified: false,
  phone: "",
  profileImage: "",
  roleID: "",
  status: "",           // whatever it was at time of deletion, e.g. "active" | "suspended"
  username: "",
  archivedAt: null,
  archivedBy: "",
  restoredAt: null,
};