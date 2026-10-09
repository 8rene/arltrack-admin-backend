// driverAssignments/{assignmentID}
//
// One row per time a driver is put on a booking. A booking can have several
// rows over its life (assigned, then reassigned, then unassigned...), but at
// most ONE row with status "assigned" at any moment -- that row is the
// booking's CURRENT driver. This replaces the driverID / driverAssignedAt /
// driverAssignedBy fields that used to live on the booking document.
//
// Plain shape only (same convention as models/booking/booking.model.js) --
// all reads/writes live in services/driverAssignments/driverAssignments.service.js.
export const DriverAssignment = {
  assignmentID: "",  // same as the Firestore doc ID
  bookingID:    "",  // FK -> bookings.bookingID (falls back to the booking doc ID for very old bookings)
  driverID:     "",  // FK -> user/{uid} where roleID resolves to "Driver"
  status:       "",  // "assigned" | "reassigned" | "unassigned" | "completed"
  assignedAt:   null,
  assignedBy:   "",  // username/uid of the Owner/Admin/Supervisor who assigned it
  endedAt:      null, // null while status === "assigned"
  endedBy:      null,
};