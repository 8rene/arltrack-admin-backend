// idResubmitRequests/{requestID} -- a customer sending a new driver's license or ID document for staff review.
// Shape only: created by submitIdResubmitRequest in controllers/user/user.controller.js (auto-generated doc ID, not a field);
// reviewed by the admin backend (services/profileRequests).
// When the account is deleted, deleteUser() rejects the user's PENDING requests (reviewNote "Account deleted."). They are deleted,
// together with the photo files they point at (newLicenseUrl / newDocumentUrl), when the archived user is permanently deleted.
export const IdResubmitRequest = {
  userID: "",
  role: "Customer",
  documentKind: "",    // "license" | "document"
  // documentKind === "license":
  currentLicenseUrl: "",
  newLicenseUrl: "",
  // documentKind === "document":
  currentDocumentUrl: "",
  newDocumentUrl: "",
  documentType: "",
  documentNumber: "",
  status: "pending",   // "pending" until staff review it
  requestedBy: "",     // same as userID
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  createdAt: null,     // server timestamp
  updatedAt: null,
};