// Cooldown records for the two driver "remind" buttons. Two separate Firestore collections, kept in one file.
// Both use the same pattern: the cooldown slot is reserved in a transaction BEFORE anyone is notified, and given back
// (previous value restored, or the document deleted) if the notification fails. Cooldown is 10 minutes for both.
// Neither document stores its own ID as a field.
//
// bookingKey vs bookingDocID (both are saved on every reminder):
//   bookingDocID = the Firestore document ID of the booking (bookings/{bookingDocID}). Use it to open the booking itself.
//   bookingKey   = the booking's "bookingID" field, or the document ID when the booking has no such field
//                  (bookingID || docID). Use it to LINK records to a booking (payments, driverAssignments, these reminders).
// For every booking the customer app creates, bookingID is set to the document ID, so the two values are the same.

// ─────────────────────────────────────────────
// balanceReminders/{bookingKey}
// The driver's "Remind customer" (unpaid balance) button. One document per booking.
// Written by services/driverDispatch/driverDispatch.service.js. The document ID is the bookingKey.
// ─────────────────────────────────────────────
export const BalanceReminder = {
  bookingKey: "",       // the booking's link key (bookingID || doc ID); also this document's ID
  bookingDocID: "",     // the booking's Firestore document ID
  driverID: "",         // the driver who pressed the button
  lastRemindedAt: null, // Firestore Timestamp; the cooldown counts from here
  count: 0,             // how many reminders this booking has had in total
};

// ─────────────────────────────────────────────
// inspectionReminders/{bookingKey}_{phase}
// The driver's "Remind staff" button on a vehicle inspection. One document per booking and phase.
// Written by services/inspectionReminders/inspectionReminders.service.js.
// The document ID is built from bookingKey + "_" + phase.
// ─────────────────────────────────────────────
export const InspectionReminder = {
  bookingKey: "",       // the booking's link key (bookingID || doc ID); the first part of this document's ID
  bookingDocID: "",     // the booking's Firestore document ID
  phase: "",            // "before" | "after"
  driverID: "",         // the driver who pressed the button
  lastRemindedAt: null, // Firestore Timestamp; the cooldown counts from here
  count: 0,             // how many reminders this booking/phase has had in total
};