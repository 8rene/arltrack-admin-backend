// Matches the 'vehicleInspectionArchives' collection in Firestore.
//
// ONE archive document per booking, written when the booking is deleted (writeInspectionArchive() in
// services/archives/vehicleInspectionArchives.service.js). It keeps the booking's four live inspection collections together:
//   inventoryBeforeTrip, inventoryAfterTrip                        part condition       (models/inventory/inventory.model.js)
//   vehicleDocumentationBeforeTrip, vehicleDocumentationAfterTrip  photos and videos    (models/vehicleDocumentation/vehicleDocumentation.model.js)
//
// Unlike the other archive models this is NOT a field-by-field copy of one live document: every live inspection document is
// nested whole inside `records`, so none of their columns appear at the top level. A booking with no inspection records gets
// no archive document.
//
// The archive document id IS the bookingID. The photo URLs inside `records` keep pointing at Firebase Storage (the files
// are never moved; only a permanent delete removes them). Restore puts every record back under its own collection and id
// (bookkeeping stripped, see services/archives/archiveMeta.js), deletes this document, then refreshes the car's live part
// condition. The restored records get no restoredAt.
export const VehicleInspectionArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored ----
  vehicleInspectionArchivesId: "",  // = the bookingID = the Firestore doc ID of this archive document
  originalId: "",          // the bookingID again, kept for consistency with the other archive models
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",          // staff uid, or "admin" when the caller passed none

  // ---- the booking's inspection records ----
  bookingID: "",
  carID: null,             // taken from the first record that has one; null when none do
  records: [],             // [{ collection, id, data }] -- collection is one of the four above, id the live doc id, data the live
                           // document exactly as it was (every field, including the dynamic part-photo fields)
};