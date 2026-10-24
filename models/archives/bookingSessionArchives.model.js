// Matches the 'bookingSessionArchives' collection in Firestore
// Primary key: bookingSessionArchivesID (Firestore document ID)
export const BookingSessionArchive = {
  bookingSessionArchivesID: "",  // Firestore doc ID
  originalId: "",                // doc ID from original 'bookingSessions' collection
  bookingSessionID: "",
  bookingID: "",                 // FK back to the (now also archived) booking
  carID: "",
  status: "",             // upcoming | active | ended | cancelled | stolen — frozen at archive time
  pickupLocation: null,
  dropoffLocation: null,
  geofenceZones: [],
  geofenceAlerts: [],
  codingAlerts: [],
  // Booking-time coding warnings, copied as-is from the session. FLAT — one entry per matched rule:
  // [{ city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }]
  // A frozen snapshot: never re-read from codingRules (see models/booking/bookingSession.model.js).
  codingWarnings: [],
  startedAt: null,               // ACTUAL pickup moment (replaces pickupTime/returnTime/activatedAt)
  startedAtSource: null,         // only set on sessions backfilled by the migration script
  droppedOffTime: null,          // the moment the vehicle was physically back on the lot (null if nobody tapped "Dropped Off")
  // Live-tracking bookkeeping, copied as-is with the rest of the session (the archive spreads every field).
  // Full descriptions: models/booking/bookingSession.model.js
  stolenAt: null,                // when the car was flagged stolen (a marker, not an end -- a stolen car keeps pinging)
  geofenceFlipCount: 0,
  lastPingReceivedAt: null,
  silentAlertedAt: null,
  needsFinalFlush: null,         // still true here only if the final history file was never saved before archiving
  pointCount: null,              // number of GPS points in the flushed trail, set together with archiveUrl
  currentPosition: null,
  archiveUrl: null,              // Storage URL, if this session was ever flushed before deletion
  lastArchivedAt: null,
  // Flattened copy of every archive/{date} day-doc this session had —
  // [{ date: "YYYY-MM-DD", points: [...] }, ...]. Not a live subcollection
  // here since an archived record never needs per-day querying.
  archiveDays: [],
  createdAt: null,
  updatedAt: null,
  archiveDate: null,
  archivedAt: null,
  archivedBy: "",
  restoredBy: null,
};