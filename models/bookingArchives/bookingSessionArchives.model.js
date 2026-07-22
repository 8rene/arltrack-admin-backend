// Matches the 'bookingSessionArchives' collection in Firestore
// Primary key: bookingSessionArchivesId (Firestore document ID)
export const BookingSessionArchive = {
  bookingSessionArchivesId: "",  // Firestore doc ID
  originalId: "",                // doc ID from original 'bookingSessions' collection
  bookingSessionID: "",
  bookingID: "",                 // FK back to the (now also archived) booking
  carID: "",
  sessionStatus: "",             // upcoming | active | ended | stolen — frozen at archive time
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
  restoredAt: null,
  restoredBy: null,
};