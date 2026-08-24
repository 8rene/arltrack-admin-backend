// Matches the 'bookingSessionArchives' collection in Firestore
// Primary key: bookingSessionArchivesId (Firestore document ID)
export const BookingSessionArchive = {
  bookingSessionArchivesId: "",  // Firestore doc ID
  originalId: "",                // doc ID from original 'bookingSessions' collection
  bookingSessionID: "",
  bookingID: "",                 // FK back to the (now also archived) booking
  carID: "",
  status: "",             // upcoming | active | ended | stolen — frozen at archive time
  pickupLocation: null,
  dropoffLocation: null,
  geofenceZones: [],
  geofenceAlerts: [],
  codingAlerts: [],
  codingCheck: null,
  pickupTime: null,
  returnTime: null,
  currentPosition: null,
  archiveUrl: null,              // Storage URL, if this session was ever flushed before deletion
  lastArchivedAt: null,
  // Flattened copy of every archive/{date} day-doc this session had —
  // [{ date: "YYYY-MM-DD", points: [...] }, ...]. Not a live subcollection
  // here since an archived record never needs per-day querying.
  archiveDays: [],
  createdAt: null,
  archiveDate: null,
  archivedAt: null,
  archivedBy: "",
  // See bookingArchives.model.js — same story: restore deletes this doc
  // rather than marking it, so restoredAt only ever arrives here inherited
  // from the live session doc if it's archived again after being restored.
  // restoredBy is fully dead (no code path writes it anymore) and has been
  // removed from this model.
  restoredAt: null,
};