// userAddress/{id}   -- a user's home address, one document per user
// Created by the customer backend at signup. The admin edits only the fields listed here (approved edit request or direct
// self-service edit, see ALLOWED_PROFILE_FIELDS in services/profileRequests/profileRequests.service.js). The document ID
// is not the userID. When an archived account is merged into a new one, the old document is moved across only if the new
// account has none (services/archives/userArchives.service.js).
export const UserAddress = {
  userID: "",       // FK to user/{userID}; this is how the document is found
  street: "",
  barangay: "",
  municipality: "",
  city: "",
  province: "",
  region: "",
  postalCode: "",  // the only postal field; the old zipCode field was merged into this one (scripts/migrateZipToPostal.js)
  createdAt: null,  // set only when the admin creates the document
  updatedAt: null,  // set when the admin edits it
};