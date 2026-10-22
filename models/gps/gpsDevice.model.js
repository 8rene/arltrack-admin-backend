// gpsDevice/{id}
//
// One doc per registered GPS tracker. The doc ID IS the device id the tracker sends as `device_id`, and it is also
// stored in gpsDeviceID. A ping from a device_id with no matching doc here is ignored, so adding the device
// (POST /api/gps/devices) is what lets a tracker report. Assigning a car (assigned: true, carID set) is what links
// the tracker to trip logic (geofence / number coding) and flips `hasDevice` on that car's upcoming bookings.
//
// Related: gpsLocations holds the tracker's latest position and links back through gpsDeviceID.
//
// Plain shape only (same convention as models/booking/booking.model.js) --
// all reads/writes live in controllers/gps/gps.controller.js.
export const GpsDevice = {
  gpsDeviceID: "",     // same as the Firestore doc ID; the tracker's device_id
  gpsName:     "",     // display name, e.g. "Gps Device Location 3" (auto-numbered on create, renamable)
  assigned:    false,  // true while a car is attached
  carID:       "",     // FK -> cars/{id}; "" when unassigned
  createdAt:   null,   // Firestore Timestamp (server time)
  updatedAt:   null,   // Firestore Timestamp: last edit/assign/unassign, and refreshed from the tracker's GNSS time on pings

  // Written by the ping handler (not on create), so it is missing until the device first reports:
  // lastLocation: { latitude, longitude }   // numbers; a copy of the last persisted position
};