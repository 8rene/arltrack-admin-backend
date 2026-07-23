// Compiles a session's full GPS trail into one permanent JSON file in
// Firebase Storage under bookingHistory/ — the Firestore-Storage pairing
// stays exactly as it was; only the SOURCE of the trail changed. It used to
// read bookingSessions/{id}/archive/{date} Firestore day-docs; now it pulls
// the same data from Google Sheets (see services/sheets/sheets.service.js),
// across every PHT date the session spans.

import { bucket } from "../../config/firebaseConnection/firebase.js";
import { getSessionById, recordArchiveFlush } from "../booking/bookingSession.service.js";
import { fetchSessionRows } from "../sheets/sheets.service.js";
import { datesBetweenPHT } from "../../utils/date/phtDate.js";

export const flushBookingHistory = async (bookingSessionID) => {
  const session = await getSessionById(bookingSessionID);
  if (!session) {
    throw new Error(`Booking session not found: ${bookingSessionID}`);
  }
  const { data } = session;

  // A session that's still active has no returnTime yet — use "now" as the
  // end of the range so today's tab is still included.
  const pickup = data.pickupTime?.toDate?.() || (data.pickupTime ? new Date(data.pickupTime) : new Date());
  const end    = data.returnTime?.toDate?.()  || (data.returnTime ? new Date(data.returnTime) : new Date());
  const dateStrings = datesBetweenPHT(pickup, end);

  const rows = await fetchSessionRows(data.carID, bookingSessionID, dateStrings);
  const fullTrail = rows
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number" && r.at)
    .map((r) => ({ lat: r.lat, lng: r.lng, at: r.at }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const filePath = `bookingHistory/${bookingSessionID}.json`;
  const file = bucket.file(filePath);

  // Shape changed from a bare points array to an object carrying this trip's
  // geofence zones + alert timeline (and coding-restriction alerts) alongside
  // the trail, so History → Review can reconstruct breach state on playback
  // instead of only showing the dots. Older archive files already in Storage
  // stay as bare arrays — the frontend handles both shapes.
  const archivePayload = {
    points: fullTrail,
    geofenceZones:  data.geofenceZones  || [],
    geofenceAlerts: data.geofenceAlerts || [],
    codingAlerts:   data.codingAlerts   || [],
  };

  await file.save(JSON.stringify(archivePayload, null, 2), {
    contentType: "application/json",
    metadata: { cacheControl: "no-cache" },
  });
  await file.makePublic();

  const archiveUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
  await recordArchiveFlush(bookingSessionID, archiveUrl);

  return archiveUrl;
};