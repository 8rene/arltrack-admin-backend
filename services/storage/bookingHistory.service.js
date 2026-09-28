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

  // pickupTime/returnTime on this doc are the SCHEDULED times set by the
  // customer app at booking time — they're never rewritten to the actual
  // pickup/return moment. A session that's still active has no returnTime
  // yet, so "now" covers that case — but even when returnTime IS set, it
  // can be stale: if the actual pickup happens later than the scheduled
  // window (a late handover, common on a short/single-day booking with
  // little schedule slack), the real GPS pings land on a date AFTER the
  // scheduled returnTime already passed. datesBetweenPHT would then see
  // end < start and silently collapse to just the (wrong) start date,
  // missing the day the trail actually lives on. Flushing always happens
  // at or after the real event, so "now" is always a safe upper bound —
  // never let the scheduled returnTime pull the end of the range earlier
  // than today.
  const toDate = (v) => v?.toDate?.() || (v ? new Date(v) : null);
  const scheduledPickup = toDate(data.pickupTime) || new Date();
  // The same problem in the other direction: pickupTime is only the SCHEDULED
  // start. If the car was actually picked up EARLIER (e.g. a booking for Oct 23
  // handed over on Sep 28), every real ping lands on a date BEFORE the scheduled
  // one, so reading only from the scheduled date finds nothing and the archive
  // comes out empty ("No data found in this archive"). Start from the earliest
  // real moment we know of: when the session was actually activated, or — for
  // sessions activated before that field existed — when it was dropped off /
  // last archived / last pinged.
  const realMoments = [data.activatedAt, data.droppedOffTime, data.lastArchivedAt, data.currentPosition?.date]
    .map(toDate)
    .filter((d) => d && !isNaN(d.getTime()));
  const pickup = new Date(Math.min(scheduledPickup.getTime(), ...realMoments.map((d) => d.getTime())));
  // Flushing always happens at or after the real event, and no ping can be
  // dated in the future — so "now" is the true upper bound. Using the
  // SCHEDULED returnTime here (as before) would make an early-picked-up trip
  // read one Sheets tab per day all the way out to its scheduled end, most of
  // them tabs that don't exist yet — wasted Sheets reads that slow down Return
  // and can hit the Sheets API quota.
  const end = new Date();
  const dateStrings = datesBetweenPHT(pickup, end);

  const rows = await fetchSessionRows(data.carID, bookingSessionID, dateStrings);
  const fullTrail = rows
    .filter((r) => typeof r.lat === "number" && typeof r.lng === "number" && r.at)
    .map((r) => ({ lat: r.lat, lng: r.lng, at: r.at, speed: r.speed ?? 0, offline: r.offline === true }))
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