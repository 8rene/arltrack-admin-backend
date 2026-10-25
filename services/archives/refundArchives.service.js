import { db } from "../../config/firebaseConnection/firebase.js";
import { resolveUserNames } from "./resolveUserName.service.js";
import { hydrateRefundRequestsWithArchives } from "./entryArchiveHydrate.service.js";
import { LINKED, chunk, restoreEntryArchivesBy, restoreLinkedForBooking } from "./linkedArchives.service.js";
import { restoreMaintenanceArchivesForBooking } from "./maintenanceArchives.service.js";
import { stripArchiveMeta } from "./archiveMeta.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// The customer's side of a refund (who asked, why, their notes) is not on the refund request any more: it is on
// the booking's cancellationRequests row. A deleted booking's rows are in cancellationRequestArchives, so look in
// both. Raw row data, newest first, per bookingID.
const getCancellationRowsForBookings = async (bookingIDs) => {
  const keys = [...new Set((bookingIDs || []).filter(Boolean))];
  const map = new Map(keys.map((k) => [k, []]));
  const ms = (v) => (v?.toMillis ? v.toMillis() : v?._seconds ? v._seconds * 1000 : v ? new Date(v).getTime() || 0 : 0);
  for (const collection of [LINKED.cancellationRequests.live, LINKED.cancellationRequests.archive]) {
    for (const part of chunk(keys, 30)) {
      const snap = await db.collection(collection).where("bookingID", "in", part).get();
      snap.docs.forEach((d) => { const row = d.data(); if (map.has(row.bookingID)) map.get(row.bookingID).push(row); });
    }
  }
  map.forEach((rows) => rows.sort((a, b) => ms(b.createdAt ?? b.requestedAt) - ms(a.createdAt ?? a.requestedAt)));
  return map;
};

// Same rules as withCancellationInfo() in refundRequest.service.js (kept as a copy so that file stays untouched):
// the row fills userID / notes / decision gaps, `reason` is the STAFF's reason, customerReason the customer's.
const isLegacyRefundDoc = (r) => !!(r && (r.userID || r.notes || r.rejectReason));
const withCancellationInfo = (r, row) => {
  if (!r) return r;
  const decided = !!(r.status && r.status !== "Pending");
  const legacy = isLegacyRefundDoc(r);
  const customerReason = (legacy ? r.reason : "") || (row && row.reason) || "";
  const decisionReason = (legacy ? r.rejectReason : r.reason) || (decided && row ? row.rejectReason : "") || "";
  return {
    ...r,
    ...(row ? {
      userID: r.userID || row.userID || null,
      notes: r.notes || row.notes || "",
      ...(decided ? {
        processedBy: r.processedBy || row.processedBy || null,
        processedAt: r.processedAt || row.processedAt || null,
      } : {}),
    } : {}),
    customerReason,
    reason: decisionReason,
    rejectReason: r.status === "Rejected" ? (decisionReason || null) : (r.rejectReason ?? null),
  };
};

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllRefundArchives = async () => {
  const snapshot = await db
    .collection("refundArchives")
    .orderBy("archivedAt", "desc")
    .get();

  // Refund docs no longer store parts[] / manualRefund / unrefundable[] -- those live in the
  // paymentEntries "out" rows (keyed by refundRequestID, which the archive copy carries).
  // The rows are archived with the booking (paymentEntryArchives); the reader looks in both collections.
  const requests = snapshot.docs.map((doc) => {
    const data = doc.data();
    return { ...data, refundRequestID: data.refundRequestID || doc.id };
  });
  const withEntries = await hydrateRefundRequestsWithArchives(requests);
  const cancellationRows = await getCancellationRowsForBookings(requests.map((r) => r.bookingID));
  const hydrated = withEntries.map((r) => {
    const rows = cancellationRows.get(r.bookingID) || [];
    const row = rows.find((x) => x.refundRequestID && x.refundRequestID === r.refundRequestID) || rows[0];
    return withCancellationInfo(r, row);
  });

  const nameMap = await resolveUserNames(hydrated.map((r) => r.userID));

  return snapshot.docs.map((doc, i) => {
    const data = hydrated[i];
    // Archives made before the rename carry amount / grossPaid; newer ones toRefundAmount / bookingPaid. Both names go out.
    const amt = data.toRefundAmount ?? data.amount;
    const paid = data.bookingPaid ?? data.grossPaid;
    return {
      refundArchivesId: doc.id,
      originalId: doc.id, // response only (the ID is no longer stored as a field)
      ...data,
      ...(amt !== undefined ? { toRefundAmount: amt, amount: amt } : {}),
      ...(paid !== undefined ? { bookingPaid: paid, grossPaid: paid } : {}),
      customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
      createdAt:   toISO(data.createdAt),
      updatedAt:   toISO(data.updatedAt),
      processedAt: toISO(data.processedAt),
      archivedAt:  toISO(data.archivedAt),
    };
  });
};

// ── HELPERS: bring the linked booking/payment back too, if still archived ──
// A refund request only ever lands in refundArchives via the booking-delete
// cascade (see services/booking/bookingDelete.service.js) — so restoring it
// on its own would leave it pointing at a bookingID/paymentID with no live
// doc, same failure mode paymentsArchives.service.js already guards
// against for its own linked booking.
const restoreLinkedBooking = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db
    .collection("bookingArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const bookingArchiveDoc = snap.docs[0];
  const archived1 = bookingArchiveDoc.data();
  const originalId = bookingArchiveDoc.id;
  const bookingOriginalData = stripArchiveMeta(archived1);

  const bookingActiveRef = originalId
    ? db.collection("bookings").doc(originalId)
    : db.collection("bookings").doc();

  await bookingActiveRef.set(bookingOriginalData);

  await bookingArchiveDoc.ref.delete();
  return true;
};

const restoreLinkedPayment = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db
    .collection("paymentsArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return false;

  const paymentArchiveDoc = snap.docs[0];
  const archived2 = paymentArchiveDoc.data();
  const originalId = paymentArchiveDoc.id;
  const paymentOriginalData = stripArchiveMeta(archived2);

  const paymentActiveRef = originalId
    ? db.collection("payments").doc(originalId)
    : db.collection("payments").doc();

  await paymentActiveRef.set(paymentOriginalData);

  await paymentArchiveDoc.ref.delete();
  return true;
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restoreRefundArchive = async (refundArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("refundArchives").doc(refundArchivesId);
  const archiveDoc = await archiveRef.get();

  if (!archiveDoc.exists) throw new Error("Archived refund request not found.");

  const archived3 = archiveDoc.data();
  const originalId = archiveDoc.id;
  const originalData = stripArchiveMeta(archived3);

  const activeRef = originalId
    ? db.collection("refundRequests").doc(originalId)
    : db.collection("refundRequests").doc();

  await activeRef.set(originalData);

  const restoredBooking = await restoreLinkedBooking(originalData.bookingID);
  const restoredPayment = await restoreLinkedPayment(originalData.bookingID);

  // The refund's "out" rows (parts / manual hand-back) were archived with the booking: bring them back with it.
  await restoreEntryArchivesBy("refundReqID", [originalData.refundRequestID || originalId]);
  if (restoredPayment) await restoreEntryArchivesBy("paymentID", [originalData.paymentID]);
  if (restoredBooking) {
    await restoreLinkedForBooking({ bookingKeys: [originalData.bookingID], kinds: ["driverAssignments", "cancellationRequests"] });
    await restoreMaintenanceArchivesForBooking({ bookingKeys: [originalData.bookingID] });
  }

  // Archive doc's job is done once the refund request is back in the live
  // collection — delete it instead of keeping a "Restored" marker around.
  await archiveRef.delete();

  return { restoredBooking, restoredPayment };
};

// ── BOOKING-ARCHIVE CASCADE ──────────────────────────────────────────────────
// Used by bookingArchives.service.js: restoring a booking brings its archived refund request(s) back;
// permanently deleting the booking archive removes them.
export const restoreRefundArchivesForBooking = async (bookingID) => {
  if (!bookingID) return 0;
  const snap = await db.collection("refundArchives").where("bookingID", "==", bookingID).get();
  for (const d of snap.docs) {
    const data = d.data();
    const batch = db.batch();
    batch.set(
      db.collection("refundRequests").doc(d.id),
      stripArchiveMeta(data)
    );
    batch.delete(d.ref);
    await batch.commit();
  }
  return snap.docs.length;
};

export const getRefundArchiveRefsForBooking = async (bookingID) => {
  if (!bookingID) return [];
  const snap = await db.collection("refundArchives").where("bookingID", "==", bookingID).get();
  return snap.docs.map((d) => d.ref);
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
export const deleteRefundArchive = async (refundArchivesId) => {
  const archiveRef = db.collection("refundArchives").doc(refundArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived refund request not found.");
  await archiveRef.delete();
};