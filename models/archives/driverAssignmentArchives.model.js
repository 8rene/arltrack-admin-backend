// Matches the 'driverAssignmentArchives' collection in Firestore.
//
// An archive is a COPY of the driverAssignments row(s) of a booking, taken when the booking is deleted (see
// services/booking/bookingDelete.service.js and services/archives/linkedArchives.core.js), plus the bookkeeping
// fields below. So it has every column models/driverAssignments/driverAssignment.model.js has -- keep the two in step.
//
// The archive document id IS the live assignmentID, so a restore writes the row back under the same id.
// Restore (a booking / payment / penalty / refund restore) moves the row back and deletes this document; the live
// row gets no restoredAt (the live model has no such column).
export const DriverAssignmentArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  driverAssignmentArchivesID: "",  // Firestore doc ID of this archive document (= originalId)
  originalId: "",          // doc ID of the original 'driverAssignments' document, reused on restore
  archiveDate: null,       // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",

  // ---- copied from the driverAssignments document (see driverAssignment.model.js) ----
  assignmentID: "",
  bookingID: "",           // FK -> bookings.bookingID
  driverID: "",            // FK -> user/{uid}
  status: "",              // "assigned" | "unassigned" | "completed" -- as it was when the booking was deleted
  assignedAt: null,
  assignedBy: "",
};
