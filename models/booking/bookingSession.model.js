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
  status:      "",
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

  // Chauffeur-only, admin-side addition. The customer's leg of the trip
  // can end well before the driver actually returns the car (driver still
  // has to drive back), so this is tracked separately from returnTime
  // rather than conflating "customer dropped off" with "trip complete".
  // Only ever set for modeOfDriving === "With Chauffeur" bookings — never
  // auto-filled/backfilled from returnTime, and never editable after the
  // fact: if it's null, nobody tapped "Dropped Off", full stop. That's a
  // deliberate choice — a guessed or backfilled timestamp here would look
  // just as authoritative as a real one with no way to tell them apart,
  // which is worse than an honest gap.
  customerDroppedOffAt: null,

  currentPosition:     null, // { lat, lng, date }
  archiveUrl:          null, // public Firebase Storage URL, set by the nightly flush job
  lastArchivedAt:      null,
  createdAt:           null,
  updatedAt:           null,
};