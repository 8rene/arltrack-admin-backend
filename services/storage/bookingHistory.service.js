// Compiles bookingSessions/{id}/archive/{date} day-docs into one permanent
// JSON file in Firebase Storage under bookingHistory/ — the Firestore
// equivalent of the test backend's Cloudinary flush.

import { db, bucket } from "../../config/firebaseConnection/firebase.js";
import { recordArchiveFlush } from "../booking/bookingSession.service.js";

export const flushBookingHistory = async (bookingSessionID) => {
  const archiveSnap = await db
    .collection("bookingSessions")
    .doc(bookingSessionID)
    .collection("archive")
    .get();

  const days = archiveSnap.docs.sort((a, b) => (a.id < b.id ? -1 : 1));
  const fullTrail = days.flatMap((doc) => doc.data()?.points || []);

  const filePath = `bookingHistory/${bookingSessionID}.json`;
  const file = bucket.file(filePath);

  await file.save(JSON.stringify(fullTrail, null, 2), {
    contentType: "application/json",
    metadata: { cacheControl: "no-cache" },
  });
  await file.makePublic();

  const archiveUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
  await recordArchiveFlush(bookingSessionID, archiveUrl);

  return archiveUrl;
};