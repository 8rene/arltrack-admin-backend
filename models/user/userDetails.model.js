// userDetails/{id}   -- a user's personal details, one document per user
// Created by the customer backend at signup. The admin edits only the fields listed here (through an approved edit request
// or a direct self-service edit, see ALLOWED_PROFILE_FIELDS in services/profileRequests/profileRequests.service.js). If a
// user somehow has none, the admin creates one the first time a change is applied. The document ID is not the userID.
export const UserDetails = {
  userID: "",       // FK to user/{userID}; this is how the document is found
  firstName: "",
  middleName: "",
  lastName: "",
  suffix: "",
  birthDate: null,
  createdAt: null,  // set only when the admin creates the document
  updatedAt: null,  // set when the admin edits it
};
