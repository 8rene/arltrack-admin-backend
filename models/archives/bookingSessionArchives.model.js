// Matches the 'bookingSessionArchives' collection in Firestore
// Primary key: bookingSessionArchivesID (Firestore document ID)
//
// ID spelling: the field STORED on the document is bookingSessionArchivesID (capital D, written when the session is
// archived). The list endpoint also adds bookingSessionArchivesId (lowercase d, copied from the doc ID) to each row it
// returns, and the admin frontend reads that one. Both hold the same value.
export const BookingSessionArchive = {
  bookingSessionArchivesID: "",  // Firestore doc ID
  // originalId is NOT stored any more: this archive document's ID IS the live document's ID (restore writes it back under that ID).
  // The archive list APIs still return it as originalId (= the document ID) so the pages keep working.
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
  needsFinalFlush: null,         // still true here only if the final history file was never saved before archiving
  pointCount: null,              // GPS points in the flushed trail. Cleared on every history save and recounted lazily, so it can be absent
  currentPosition: null,
  archiveUrl: null,              // Storage URL, if this session was ever flushed before deletion
  lastArchivedAt: null,
  createdAt: null,
  updatedAt: null,
  archiveDate: null,
  archivedAt: null,
  archivedBy: "",
};