// bookingSessions/{bookingSessionID}
//
// The DOCUMENT is created by the customer backend at booking time (own
// bookingSessionID as the doc's real ID, bookingID stored as an FK field
// only — see the customer repo's models/bookingSession/bookingsession.model.js
// for the fields set at creation: pickupLocation, dropoffLocation,
// geofenceZones, codingCheck, pickupTime, returnTime).
//
// This is a plain shape, same convention as models/car/car.model.js — no
// Firestore calls here. All reads/writes live in
// services/booking/bookingSession.service.js instead.
export const BookingSession = {
  bookingSessionID: "",
  bookingID:         "",  // FK to bookings/{id} — doc ID is NOT this value
    // upcoming | active | ended | cancelled | stolen
  sessionStatus:      "",
  // carID is denormalized here on dispatch/pickup, so a GPS ping can
  // resolve straight to a session with one query instead of reading the
  // booking doc on every single ping. NOT re-derived from the live
  // gpsDevice↔car assignment on every ping, so reassigning a device to a
  // different car mid-trip can never quietly reattach an in-progress
  // session to the wrong car.
  carID:              "",
  pickupLocation:      null, // { address, lat, lng }
  dropoffLocation:     null, // { address, lat, lng }
  geofenceZones:       [],
  geofenceAlerts:      [],
  codingAlerts:        [],
  codingCheck:         null,
  pickupTime:          null,
  returnTime:          null,
  currentPosition:     null, // { lat, lng, date }
  archiveUrl:          null, // public Firebase Storage URL, set by the nightly flush job
  lastArchivedAt:      null,
  createdAt:           null,
  updatedAt:           null,
};