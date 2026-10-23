// bookingSessions/{bookingSessionID}
//
// The DOCUMENT is created by the customer backend at booking time (own
// bookingSessionID as the doc's real ID, bookingID stored as an FK field
// only — see the customer repo's models/bookingSession/bookingsession.model.js
// for the fields set at creation: pickupLocation, dropoffLocation,
// geofenceZones, codingWarnings). The scheduled pickup/return dates are NOT
// copied here — they live on the booking (startDateTime/endDateTime).
//
// GPS pings are NOT stored on this doc. Each ping is appended to a Google
// Sheet (one tab per PHT date, shared by all cars — see
// services/sheets/sheets.service.js) and matched back to this session by
// sessionId + carID + the startedAt date range. The history flush compiles
// that trail into a JSON file in Firebase Storage; archiveUrl points to it.
// The old bookingSessions/{id}/archive sub-collection is no longer used.
//
// This is a plain shape, same convention as models/car/car.model.js — no
// Firestore calls here. All reads/writes live in
// services/booking/bookingSession.service.js instead.
export const BookingSession = {
  bookingSessionID: "",
  bookingID:         "",  // FK to bookings/{id} — doc ID is NOT this value
    // upcoming | active | ended | cancelled | stolen
  status:      "",
  // carID is denormalized here AT PICKUP (set by markSessionActive when the
  // session goes active), so it is empty until the trip starts. It lets a GPS ping
  // resolve straight to a session with one query instead of reading the
  // booking doc on every single ping. NOT re-derived from the live
  // gpsDevice↔car assignment on every ping, so reassigning a device to a
  // different car mid-trip can never quietly reattach an in-progress
  // session to the wrong car.
  carID:              "",
  pickupLocation:      null, // { address, lat, lng }
  dropoffLocation:     null, // { address, lat, lng }
  // [{ label, lat, lng, radius }] — radius in METERS. The ONLY place a trip's zones are stored: the car doc keeps
  // none. Written by the CUSTOMER backend at booking ([Pickup, <destination>, ...extra stops], one per point that has
  // coordinates; pickup coordinates are required, so a new session always has at least Pickup). Staff edit them
  // afterwards from Car Tracking > Booking Information, for an upcoming or an active trip
  // (PATCH /api/gps/:carId/geofence with this doc's bookingSessionID, which overwrites the whole list), and
  // updateSessionDestination moves the destination zone when a booking's destination changes.
  // Read by livePing.service.js to raise geofence alerts. Older sessions may be [].
  geofenceZones:       [],
  geofenceAlerts:      [],
  codingAlerts:        [],
  // Alert entries written from a live ping also carry `receivedAt` (server time) and, when the ping
  // reached the server >2 min after the tracker recorded it, `delayed: true`. `at` stays the time it happened.
  // Written by livePing.service.js / silentTracker.service.js while a trip is active (not set at creation):
  //   geofenceFlipCount  — consecutive pings disagreeing with the logged geofence state (2 = real change)
  //   lastPingReceivedAt — ISO time the server last heard from the tracker
  //   silentAlertedAt    — set when staff were told the tracker went silent; removed on the next ping
  //   stolenAt           — when the car was flagged stolen (markSessionStolen). A stolen car keeps pinging, so this is
  //                        a marker, not an end: sessionEndedAt() still treats stolen as "still going".
  //   needsFinalFlush    — set when the trip ends / is flagged stolen, removed once its final history file is saved;
  //                        the nightly job retries any session that still has it (getSessionsNeedingFinalFlush).
  // Alert entries may also carry `afterDropOff: true` (written once droppedOffTime was set: a geofence breach that
  // was closed by the drop-off, or a coding restriction that happened afterwards) and, for coding "restricted"
  // entries, `plate` (the plate masked like "P*****2").
  // Number Coding restrictions found for the car's plate BEFORE the booking was
  // made — the list the customer was warned about. FLAT: one entry per matched rule,
  // no nested arrays.
  // This is a SNAPSHOT / backup: the city, digit, day and time window are copied in, so
  // the admin never looks anything up in codingRules to show it — it still reads
  // correctly after the rule is edited or deleted.
  // Written by the CUSTOMER backend; the admin only READS it. A booking can't proceed
  // unless the customer agrees, so no acknowledgement is stored here. Older sessions
  // simply lack it (read as []).
  // Entry: { city, plateLastDigit, ruleID, dayOfWeek, startTime, endTime }
  //   ruleID only records WHICH rule matched (codingRules/{ruleID}, see
  //   models/codingRules/codingRules.model.js) — it may no longer exist; never rely on it.
  codingWarnings:      [],
  // ACTUAL pickup moment. Stamped once by markSessionActive; null until the
  // trip starts (so upcoming/cancelled sessions have none). Traceback and the
  // history flush use it to pick which Sheets date-tabs to read, so an early
  // pickup still looks at the right days. Replaces the old activatedAt.
  // Sessions backfilled by scripts/migrate-session-dates.js from the old
  // SCHEDULED pickup also carry startedAtSource ("pickupTime(scheduled)") so
  // an approximate value can't be mistaken for a real one.
  startedAt:           null, // timestamp | null
  startedAtSource:     null, // only set by the migration script

  // Admin-side addition, set for EVERY booking (self-drive and chauffeur
  // alike) — the moment the vehicle itself is physically back on the lot,
  // as distinct from the booking's completedAt (stamped once Mark Complete is confirmed).
  // Whoever has custody of the car marks this: the assigned driver on a
  // chauffeur booking, or a supervisor/staff member on a self-drive one
  // (there's no driver to do it on those). This is the single moment used
  // for the late-fee calculation for every booking type — never
  // auto-filled/backfilled from completedAt, and never editable after the
  // fact: if it's null, nobody tapped "Dropped Off", full stop. That's a
  // deliberate choice — a guessed or backfilled timestamp here would look
  // just as authoritative as a real one with no way to tell them apart,
  // which is worse than an honest gap.
  droppedOffTime: null,

  currentPosition:     null, // { lat, lng, date }
  archiveUrl:          null, // public Firebase Storage URL, set by the nightly flush job
  pointCount:          null, // number of GPS points in the flushed trail, set with archiveUrl
  lastArchivedAt:      null,
  createdAt:           null,
  updatedAt:           null,
};