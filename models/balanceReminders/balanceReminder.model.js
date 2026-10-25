// balanceReminders/{bookingKey}
// Cooldown record for the driver's "Remind customer" (unpaid balance) button. One document per booking.
// Written by services/driverDispatch/driverDispatch.service.js, same transactional reserve-then-notify pattern as
// inspectionReminders. 10-minute cooldown. The document ID is the bookingKey and is not stored as a field.
export const BalanceReminder = {
  bookingKey: "",       // the booking's business ID
  bookingDocID: "",     // the booking's Firestore doc ID
  driverID: "",         // the driver who pressed the button
  lastRemindedAt: null, // Firestore Timestamp; the cooldown counts from here
  count: 0,             // how many reminders this booking has had in total
};
