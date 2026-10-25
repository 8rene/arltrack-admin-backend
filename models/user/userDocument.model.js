// userDocument/{id}   -- a user's driver's license and ID document, one document per user
// Created by the customer backend at signup. The admin updates it when an ID/license resubmission is approved
// (upsertUserDocument in services/profileRequests/profileRequests.service.js), which creates it if the user has none.
// The document ID is not the userID. Read nightly by jobs/midinghtFlush.job.js to lock accounts with an expired license.
export const UserDocument = {
  userDocumentID: "",       // own unique ID (a uuid) written by the customer backend at signup; NOT the userID and NOT the doc ID
  userID: "",                // FK to user/{userID}; this is how the document is found
  driverLicenseUrl: "",     // photo of the license
  driverLicenseExpiry: null,// expiry date of the license; the reviewer types it when approving a new license
  documentImageUrl: "",     // photo of the government ID (the non-license document)
  documentType: "",         // type of that ID; only changes when the resubmission carried one
  documentNumber: "",       // number of that ID; only changes when the resubmission carried one
  driversLicenseNumber: "", // license number typed at signup (written by the customer backend). NOTE the spelling: "drivers", unlike driverLicenseUrl / driverLicenseExpiry
  selfieWithIdUrl: "",      // selfie holding the ID, uploaded at signup (customer backend)
  createdAt: null,          // set only when the admin creates the document
  updatedAt: null,          // set when the admin edits it
};
