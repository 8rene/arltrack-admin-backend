// inspectionReminders/{bookingKey}_{phase}
// Cooldown record for the driver's "Remind staff" button on a vehicle inspection. One document per booking and phase.
// Written by services/inspectionReminders/inspectionReminders.service.js: the slot is reserved in a transaction BEFORE the
// staff are notified, and given back (previous value restored, or the document deleted) if the notification fails.
// 10-minute cooldown. The document ID is built from bookingKey + "_" + phase and is not stored as a field.
export const InspectionReminder = {
  bookingKey: "",       // the booking's business ID (falls back to the doc ID)
  bookingDocID: "",     // the booking's Firestore doc ID
  phase: "",            // "before" | "after"
  driverID: "",         // the driver who pressed the button
  lastRemindedAt: null, // Firestore Timestamp; the cooldown counts from here
  count: 0,             // how many reminders this booking/phase has had in total
};
