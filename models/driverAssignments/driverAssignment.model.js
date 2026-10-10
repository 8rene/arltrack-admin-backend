// driverAssignments/{assignmentID}
//
// ONE row per booking, updated in place: reassigning changes driverID / assignedAt / assignedBy on the same row,
// unassigning sets status "unassigned" and finishing the trip sets "completed". A row with status "assigned" is
// the booking's CURRENT driver. This replaces the driverID / driverAssignedAt / driverAssignedBy fields that
// used to live on the booking document. There is no endedAt / endedBy: nothing recorded them usefully (endedBy
// was empty on every row) and the previous driver's history is deliberately not kept.
// If an older version left several "assigned" rows for one booking, the extra ones are set to "unassigned".
//
// Plain shape only (same convention as models/booking/booking.model.js) --
// all reads/writes live in services/driverAssignments/driverAssignments.service.js.
export const DriverAssignment = {
  assignmentID: "",  // same as the Firestore doc ID
  bookingID:    "",  // FK -> bookings.bookingID (falls back to the booking doc ID for very old bookings)
  driverID:     "",  // FK -> user/{uid} where roleID resolves to "Driver"
  status:       "",  // "assigned" | "unassigned" | "completed"
  assignedAt:   null,
  assignedBy:   "",  // username/uid of the Owner/Admin/Supervisor who assigned it
};