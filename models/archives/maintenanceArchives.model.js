// Matches the 'maintenanceArchives' collection in Firestore.
//
// An archive is a COPY of a booking-linked maintenance document (bookingID set), taken when its booking is deleted
// (see services/booking/bookingDelete.service.js and services/archives/maintenanceArchives.service.js), plus the
// bookkeeping fields below. So it has every column models/maintenance/maintenance.model.js has -- keep the two in
// step. Routine maintenance (bookingID null) is not tied to a rental and is never archived.
//
// The archive document id IS the live maintenanceID, so a restore writes the record back under the same id (a
// penalty's maintenanceID still points at it). Restore (a maintenance restore, or restoring its booking) puts the
// record back in `maintenance` and deletes this document; the live record gets no restoredAt (the live model has no
// such column).
//
// The Maintenance Archive page also shows plateNumber / brandName / modelName: resolved on read from carID, not stored.
export const MaintenanceArchive = {
  // ---- bookkeeping: written by the archive, NEVER restored (see services/archives/archiveMeta.js) ----
  maintenanceArchivesId: "",  // Firestore doc ID of this archive document (= originalId; lowercase "d" like the penalty / refund archives)
  originalId: "",             // doc ID of the original 'maintenance' document, reused on restore
  archiveDate: null,          // set when archived (same moment as archivedAt)
  archivedAt: null,
  archivedBy: "",

  // ---- copied from the maintenance document (see maintenance.model.js) ----
  maintenanceID: "",
  carID: "",                  // FK -> cars
  bookingID: "",              // FK -> bookings.bookingID (always set on an archived record)
  basis: "",                  // Post-Rental | Monthly | Mileage-based | Annual | Repair/Unplanned
  services: [],               // [{ serviceID, serviceName, price, ... }]
  totalCost: 0,
  overrideTotal: null,
  description: "",
  maintenanceDate: null,
  nextMaintenanceDate: null,
  status: "",                 // Scheduled | Completed | Cancelled (as it was when the booking was deleted)
  partsAddressed: [],
  createdAt: null,
  updatedAt: null,
};