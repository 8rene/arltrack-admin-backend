// gpsLocations/{docID}
//
// ONE doc per GPS tracker holding its LATEST position -- every ping overwrites the same doc, so this is the
// live-map snapshot, not a history. The first ping from a registered device creates the doc; later pings update it.
// Pings from unregistered devices (no matching gpsDevice) or from outside the Philippines are dropped before
// anything is written here. A parked tracker re-sending the same fix is not written again.
//
// Related: gpsDevice/{id} is the registered tracker (which car it is on) and links here through gpsDeviceID.
// A tracker's own gpsDevice doc also keeps an updatedAt copy (the time of its last ping).
//
// Plain shape only (same convention as models/booking/booking.model.js) --
// all reads/writes live in controllers/gps/gps.controller.js, and the doc-id / list caching is in
// services/gps/gpsLookupCache.js (in memory only, nothing is stored for it in Firestore).
export const GpsLocation = {
  gpsDeviceID: "",     // FK -> gpsDevice.gpsDeviceID (same as that doc's ID); the tracker's device_id
  latitude:    0,      // number
  longtitude:  0,      // number. Spelled "longtitude" on purpose -- that is the field name in the DB. The
                       // readers also accept "longitude" as a fallback, but new docs are always written as longtitude.
  speed:       0,      // number, 0 when the tracker does not send it
  offline:     false,  // true when the tracker flagged the ping as buffered/replayed (sent after it reconnected)
  updatedAt:   null,   // Firestore Timestamp: the tracker's own GNSS time (recorded_at), or receive time if missing
  createdAt:   null,   // Firestore Timestamp: when this doc was first created (server time)

  // lastLocation: { latitude, longitude } -- legacy text/object some old docs carry. The backend never refreshes
  // it, so do not rely on it; use latitude / longtitude.
};