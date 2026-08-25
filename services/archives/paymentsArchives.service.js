import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveUserNames } from "./resolveUserName.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// Archived payments only store bookingID, not userID directly — same as the
// live payments.service.js, the customer has to be resolved by looking up
// the booking first. The booking itself may be live or already archived
// (a payment can be restored independently, see restoreLinkedBooking below),
// so check both collections.
const resolveBookingUserIDs = async (bookingIDs) => {
  const uniqueIDs = [...new Set(bookingIDs.filter(Boolean))];
  const userIDByBooking = {};

  await Promise.all(uniqueIDs.map(async (bookingID) => {
    const liveSnap = await db.collection("bookings")
      .where("bookingID", "==", bookingID).limit(1).get();
    if (!liveSnap.empty) {
      userIDByBooking[bookingID] = liveSnap.docs[0].data().userID;
      return;
    }
    const archivedSnap = await db.collection("bookingArchives")
      .where("bookingID", "==", bookingID).limit(1).get();
    if (!archivedSnap.empty) {
      userIDByBooking[bookingID] = archivedSnap.docs[0].data().userID;
    }
  }));

  return userIDByBooking;
};

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllPaymentsArchives = async () => {
  const snapshot = await db
    .collection("paymentsArchives")
    .orderBy("archivedAt", "desc")
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      paymentsArchivesId: doc.id,
      ...data,
      createdAt:  toISO(data.createdAt),
      updatedAt:  toISO(data.updatedAt),
      archivedAt: toISO(data.archivedAt),
      restoredAt: toISO(data.restoredAt),
    };
  });

  const userIDByBooking = await resolveBookingUserIDs(rows.map((r) => r.bookingID));
  const nameMap = await resolveUserNames(Object.values(userIDByBooking));

  return rows.map((r) => ({
    ...r,
    customerName: nameMap[userIDByBooking[r.bookingID]] || "—",
  }));
};

// ── HELPER: bring the linked booking back too, if it's still archived ─────────
// A payment can be restored on its own from the Payments Archive page,
// without going through Booking Archive's cascade restore. If the linked
// booking is left behind in bookingArchives, the restored payment ends up
// live in `payments` pointing at a bookingID with no live `bookings` doc.
// Payments.jsx resolves the Customer column by looking up the booking for
// its userID — so that row's Customer cell shows "—" until the booking is
// also restored. Restoring it here keeps both collections in sync no
// matter which archive page the admin restores from.
const restoreLinkedBooking = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db
    .collection("bookingArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const bookingArchiveDoc = snap.docs[0];
  const {
    bookingArchivesId: _skip,
    originalId,
    archivedAt: _ba,
    archivedBy: _bab,
    restoredAt: _br,
    restoredBy: _brb,
    customerName: _bcn, // resolved field — not part of the original bookings schema
    ...bookingOriginalData
  } = bookingArchiveDoc.data();

  const bookingActiveRef = originalId
    ? db.collection("bookings").doc(originalId)
    : db.collection("bookings").doc();

  await bookingActiveRef.set({
    ...bookingOriginalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Cascade-restoring the booking archive doc too, same as Booking
  // Archive's own restore does, so the two pages never disagree about
  // whether a given booking is "still archived".
  await bookingArchiveDoc.ref.delete();
  return true;
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restorePaymentsArchive = async (paymentsArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("paymentsArchives").doc(paymentsArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived payment not found.");

  const {
    paymentsArchivesId: _skip,
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    customerName,          // resolved field — not part of original payments schema
    ...originalData
  } = archiveDoc.data();

  const activeRef = originalId
    ? db.collection("payments").doc(originalId)
    : db.collection("payments").doc();

  await activeRef.set({
    ...originalData,
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);

  // Archive doc's job is done once the payment is back in the live
  // collection — delete it instead of keeping a "Restored" marker around.
  await archiveRef.delete();

  return { restoredBooking };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deletePaymentsArchive = async (paymentsArchivesId) => {
  const archiveRef = db.collection("paymentsArchives").doc(paymentsArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived payment not found.");
  await archiveRef.delete();
};