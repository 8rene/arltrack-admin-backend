// editRequests/{requestID}   -- a user's request to change their own profile fields; staff approve or reject it.
// The doc ID is Firestore's auto ID (add()), and it is NOT stored as a field. The request is the refID of its
// "edit_request" notification.
// Written by createEditRequest(), approveProfileRequest(), rejectRequest() and cancelEditRequest() in
// services/profileRequests/profileRequests.service.js. The sibling collection for license / ID photo changes is
// idResubmitRequests (models/user/idResubmitRequest.model.js).
//
// Only the fields in ALLOWED_PROFILE_FIELDS (same file) can be in `changes`, so a request can never touch roleID,
// status and similar. Approving applies every change to the collection it belongs to (applyProfileChanges).
// When the account is deleted, deleteUser() rejects the user's PENDING requests (closePendingRequestsForUser, reviewNote "Account deleted.");
// the requests are deleted when the archived user is permanently deleted (deleteUserArchive in userArchives.service.js).
export const EditRequest = {
  userID: "",          // the user whose profile changes (always taken from the verified token, never the request body)
  requestedBy: "",     // uid of whoever submitted it; same as userID. Only this person can cancel it
  role: "",            // the requester's role when they submitted it
  status: "",          // "pending" | "approved" | "rejected" | "cancelled" ("cancelled" = the requester withdrew it while pending)
  changes: [],         // [{ collection, field, newValue, oldValue?, label? }]
                       //   collection: "user" | "userDetails" | "userAddress"
                       //   field: e.g. "phone", "username", "firstName", "birthDate", "street"
                       //   newValue is what gets written on approval; oldValue / label are display-only
  reviewedBy: null,    // uid of the staff member who approved / rejected it; null while pending or cancelled
  reviewedAt: null,    // timestamp of that decision
  reviewNote: null,    // reason typed when rejecting (shown to the requester); null otherwise
  createdAt: null,
  updatedAt: null,     // also stamped when the requester cancels it
};