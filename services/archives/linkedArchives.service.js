// driverAssignmentArchives / cancellationRequestArchives / paymentEntryArchives.
// These have NO page of their own: they are written when a booking is deleted, come back when it is restored and are
// removed when its archive is permanently deleted. The payment / penalty / refund archive pages read the entries from
// here (entryArchiveHydrate.service.js).
//
// An archive doc is a COPY of the live doc plus the bookkeeping in archiveMeta.js, and its id IS the live doc id
// (direct cancellation rows are keyed by booking, entries by "<paymentID>_deposit"; re-archiving overwrites instead of
// duplicating). A restored row gets no restoredAt: the live models have no such column.
import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { stripArchiveMeta } from "./archiveMeta.js";

export const LINKED = {
  driverAssignments:    { live: "driverAssignments",    archive: "driverAssignmentArchives",    idKey: "driverAssignmentArchivesID" },
  cancellationRequests: { live: "cancellationRequests", archive: "cancellationRequestArchives", idKey: "cancellationRequestArchivesID" },
  paymentEntries:       { live: "paymentEntries",       archive: "paymentEntryArchives",        idKey: "paymentEntryArchivesID" },
};
export const LINKED_KINDS = Object.keys(LINKED);

const IN_LIMIT = 30;       // Firestore `in` takes at most 30 values
const BATCH_WRITES = 400;  // a batch takes at most 500 writes
const stamp = () => admin.firestore.FieldValue.serverTimestamp();

export const uniq = (list) => [...new Set((list || []).filter((v) => v !== null && v !== undefined && v !== "").map(String))];
export const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const dedupe = (docs) => [...new Map(docs.map((d) => [d.id, d])).values()];

const queryIn = async (collection, field, values) => {
  const out = [];
  for (const part of chunk(uniq(values), IN_LIMIT)) out.push(...(await db.collection(collection).where(field, "in", part).get()).docs);
  return out;
};
// a direct cancellation row has the booking key as its doc id (very old ones carry no bookingID at all)
const byDocID = async (collection, keys) =>
  (await Promise.all(keys.map((k) => db.collection(collection).doc(k).get()))).filter((s) => s.exists);

// ── DELETE side: what is live for this booking. bookingKeys = its bookingID field AND its doc id;
// entries written without a bookingID are found through the payment id. Returns { kind: [snapshot] }.
export const collectLinkedForBooking = async ({ bookingKeys, paymentIDs = [] }) => {
  const keys = uniq(bookingKeys);
  return {
    driverAssignments: dedupe(await queryIn(LINKED.driverAssignments.live, "bookingID", keys)),
    cancellationRequests: dedupe([
      ...(await queryIn(LINKED.cancellationRequests.live, "bookingID", keys)),
      ...(await byDocID(LINKED.cancellationRequests.live, keys)),
    ]),
    paymentEntries: dedupe([
      ...(await queryIn(LINKED.paymentEntries.live, "bookingID", keys)),
      ...(await queryIn(LINKED.paymentEntries.live, "paymentID", paymentIDs)),
    ]),
  };
};

/** Writes the archive copies (chunked batches); deletes nothing. Returns { kind: count }. */
export const writeLinkedArchives = async (collected, archivedBy = "admin") => {
  const counts = {};
  for (const kind of LINKED_KINDS) {
    const { archive, idKey } = LINKED[kind];
    const docs = collected?.[kind] || [];
    counts[kind] = docs.length;
    for (const part of chunk(docs, BATCH_WRITES)) {
      const batch = db.batch();
      part.forEach((d) => batch.set(db.collection(archive).doc(d.id), {
        [idKey]: d.id, archiveDate: stamp(), archivedAt: stamp(), archivedBy, ...d.data(),
      }));
      await batch.commit();
    }
  }
  return counts;
};

/** Live refs of everything collected, for the delete phase. */
export const linkedLiveRefs = (collected) => LINKED_KINDS.flatMap((kind) => (collected?.[kind] || []).map((d) => d.ref));

// ── RESTORE / PERMANENT DELETE side
const findArchives = async (kind, field, values) => {
  const docs = await queryIn(LINKED[kind].archive, field, values);
  if (kind === "cancellationRequests" && field === "bookingID") docs.push(...(await byDocID(LINKED[kind].archive, uniq(values))));
  return dedupe(docs);
};

const restoreLinkedArchives = async (kind, field, values) => {
  const docs = await findArchives(kind, field, values);
  for (const part of chunk(docs, BATCH_WRITES / 2)) {
    const batch = db.batch();
    part.forEach((d) => {
      batch.set(db.collection(LINKED[kind].live).doc(d.id), stripArchiveMeta(d.data()));
      batch.delete(d.ref);
    });
    await batch.commit();
  }
  return docs.length;
};

/** Everything archived for a booking back to live. `kinds` limits which of the three come back. */
export const restoreLinkedForBooking = async ({ bookingKeys, paymentIDs = [], kinds = LINKED_KINDS }) => {
  const out = {};
  for (const kind of kinds) {
    out[kind] = await restoreLinkedArchives(kind, "bookingID", bookingKeys);
    if (kind === "paymentEntries" && uniq(paymentIDs).length) out[kind] += await restoreLinkedArchives(kind, "paymentID", paymentIDs);
  }
  return out;
};

/** Payment entries by one of their own keys: "paymentID" | "penaltyID" | "refundReqID". */
export const restoreEntryArchivesBy = (field, values) => restoreLinkedArchives("paymentEntries", field, values);

/** Refs of every linked archive row of a booking (booking archive deleted for good). */
export const getLinkedArchiveRefsForBooking = async ({ bookingKeys, paymentIDs = [] }) => {
  const refs = [];
  for (const kind of LINKED_KINDS) {
    let docs = await findArchives(kind, "bookingID", bookingKeys);
    if (kind === "paymentEntries" && uniq(paymentIDs).length) docs = dedupe([...docs, ...(await findArchives(kind, "paymentID", paymentIDs))]);
    refs.push(...docs.map((d) => d.ref));
  }
  return refs;
};