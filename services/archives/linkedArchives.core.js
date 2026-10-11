// Archives for the three normalized collections that hang off a booking:
//
//   driverAssignments     -> driverAssignmentArchives
//   cancellationRequests  -> cancellationRequestArchives
//   paymentEntries        -> paymentEntryArchives
//
// Same idea as bookingArchives / paymentsArchives: an archive document is a COPY of the live document (every
// column of the live model, nothing added, nothing renamed) plus the bookkeeping fields listed in archiveMeta.js.
// Restoring strips the bookkeeping and writes the copy back under its ORIGINAL id.
//
// Two differences from the older archives, both on purpose:
//   - The archive document id IS the live document id (instead of an auto id). The ids matter: a direct
//     cancellation row is keyed by its booking, a payment entry by "<paymentID>_deposit" ... and the webhook /
//     idempotency code finds rows by them. Re-archiving after a half-finished delete overwrites instead of
//     duplicating, and a restore puts the row back under the exact id it had.
//   - A restored row does NOT get a restoredAt stamp: the live models of these three collections have no such
//     column, and archiving must not change the live design.
//
// `db` is passed in (like paymentEntries.core.js) so this can be tested against a fake Firestore.
// linkedArchives.service.js binds it to the real connection.
import { stripArchiveMeta } from "./archiveMeta.js";

export const LINKED = {
  driverAssignments: {
    live: "driverAssignments",
    archive: "driverAssignmentArchives",
    idKey: "driverAssignmentArchivesID",
    label: "driver assignment",
  },
  cancellationRequests: {
    live: "cancellationRequests",
    archive: "cancellationRequestArchives",
    idKey: "cancellationRequestArchivesID",
    label: "cancellation request",
  },
  paymentEntries: {
    live: "paymentEntries",
    archive: "paymentEntryArchives",
    idKey: "paymentEntryArchivesID",
    label: "payment entry",
  },
};
export const LINKED_KINDS = Object.keys(LINKED);

// Firestore: `in` takes at most 30 values, a batch at most 500 writes.
const IN_LIMIT = 30;
const BATCH_WRITES = 400;

const uniq = (list) => [...new Set((list || []).filter((v) => v !== null && v !== undefined && v !== "").map(String))];
const chunk = (list, n) => {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};
const dedupe = (docs) => {
  const byID = new Map();
  docs.forEach((d) => byID.set(d.id, d));
  return [...byID.values()];
};
const toISO = (val) => (val && val.toDate ? val.toDate().toISOString() : val ?? null);

export const makeLinkedArchives = (db, { now = () => new Date() } = {}) => {
  const queryIn = async (collection, field, values) => {
    const out = [];
    for (const part of chunk(uniq(values), IN_LIMIT)) {
      const snap = await db.collection(collection).where(field, "in", part).get();
      out.push(...snap.docs);
    }
    return out;
  };

  // A direct cancellation row is stored under the booking key as its doc id, and a very old one may not carry
  // bookingID at all -- so those are also looked up by id.
  const byDocID = async (collection, keys) => {
    const snaps = await Promise.all(keys.map((k) => db.collection(collection).doc(k).get()));
    return snaps.filter((s) => s.exists);
  };

  // ---------------------------------------------------------------------------------------------------------
  // DELETE side: what is live for this booking right now.
  //   bookingKeys  every key the booking is known by (its bookingID field AND its Firestore doc id)
  //   paymentIDs   the booking's payment id(s): entries written without a bookingID are still found through it
  // Returns { driverAssignments: [doc], cancellationRequests: [doc], paymentEntries: [doc] } (Firestore snapshots).
  // ---------------------------------------------------------------------------------------------------------
  const collectLinkedForBooking = async ({ bookingKeys, paymentIDs = [] }) => {
    const keys = uniq(bookingKeys);
    const pids = uniq(paymentIDs);
    return {
      driverAssignments: dedupe(await queryIn(LINKED.driverAssignments.live, "bookingID", keys)),
      cancellationRequests: dedupe([
        ...(await queryIn(LINKED.cancellationRequests.live, "bookingID", keys)),
        ...(await byDocID(LINKED.cancellationRequests.live, keys)),
      ]),
      paymentEntries: dedupe([
        ...(await queryIn(LINKED.paymentEntries.live, "bookingID", keys)),
        ...(await queryIn(LINKED.paymentEntries.live, "paymentID", pids)),
      ]),
    };
  };

  /** Writes the archive copies (chunked batches). Nothing is deleted here. Returns { kind: count }. */
  const writeLinkedArchives = async (collected, archivedBy = "admin") => {
    const counts = {};
    for (const kind of LINKED_KINDS) {
      const cfg = LINKED[kind];
      const docs = (collected && collected[kind]) || [];
      counts[kind] = docs.length;
      for (const part of chunk(docs, BATCH_WRITES)) {
        const batch = db.batch();
        part.forEach((d) => {
          batch.set(db.collection(cfg.archive).doc(d.id), {
            [cfg.idKey]: d.id,
            originalId: d.id,
            archiveDate: now(),
            archivedAt: now(),
            archivedBy,
            ...d.data(),
          });
        });
        await batch.commit();
      }
    }
    return counts;
  };

  /** Live refs of everything collected, for the delete phase. */
  const linkedLiveRefs = (collected) => LINKED_KINDS.flatMap((kind) => ((collected && collected[kind]) || []).map((d) => d.ref));

  // ---------------------------------------------------------------------------------------------------------
  // RESTORE side
  // ---------------------------------------------------------------------------------------------------------
  const findArchives = async (kind, field, values) => {
    const cfg = LINKED[kind];
    const keys = uniq(values);
    const docs = await queryIn(cfg.archive, field, keys);
    // a direct cancellation row archived without a bookingID is found through its doc id (= the booking key)
    if (kind === "cancellationRequests" && field === "bookingID") docs.push(...(await byDocID(cfg.archive, keys)));
    return dedupe(docs);
  };

  /** Moves the matching archive rows back into their live collection. Returns how many came back. */
  const restoreLinkedArchives = async (kind, field, values) => {
    const cfg = LINKED[kind];
    const docs = await findArchives(kind, field, values);
    for (const part of chunk(docs, BATCH_WRITES / 2)) {
      const batch = db.batch();
      part.forEach((d) => {
        const data = d.data();
        batch.set(db.collection(cfg.live).doc(data.originalId || d.id), stripArchiveMeta(data));
        batch.delete(d.ref);
      });
      await batch.commit();
    }
    return docs.length;
  };

  /**
   * Everything archived for a booking, back into the live collections.
   *   kinds  which of the three to restore (the standalone payment / penalty / refund restores only need the
   *          driver and the cancellation history back along with the booking; entries come back by their own key).
   * Returns { driverAssignments: n, cancellationRequests: n, paymentEntries: n } for the kinds asked for.
   */
  const restoreLinkedForBooking = async ({ bookingKeys, paymentIDs = [], kinds = LINKED_KINDS }) => {
    const out = {};
    for (const kind of kinds) {
      out[kind] = await restoreLinkedArchives(kind, "bookingID", bookingKeys);
      if (kind === "paymentEntries" && uniq(paymentIDs).length) {
        out[kind] += await restoreLinkedArchives(kind, "paymentID", paymentIDs);
      }
    }
    return out;
  };

  /** Payment entries by one of their own keys: "paymentID" | "penaltyID" | "refundReqID". */
  const restoreEntryArchivesBy = (field, values) => restoreLinkedArchives("paymentEntries", field, values);

  // ---------------------------------------------------------------------------------------------------------
  // PERMANENT DELETE side (booking archive deleted for good): the refs of every linked archive row.
  // ---------------------------------------------------------------------------------------------------------
  const getLinkedArchiveRefsForBooking = async ({ bookingKeys, paymentIDs = [] }) => {
    const refs = [];
    for (const kind of LINKED_KINDS) {
      let docs = await findArchives(kind, "bookingID", bookingKeys);
      if (kind === "paymentEntries" && uniq(paymentIDs).length) {
        docs = dedupe([...docs, ...(await findArchives(kind, "paymentID", paymentIDs))]);
      }
      refs.push(...docs.map((d) => d.ref));
    }
    return refs;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Archive pages: list + permanent delete of a single row.
  // ---------------------------------------------------------------------------------------------------------
  const listLinkedArchives = async (kind) => {
    const cfg = LINKED[kind];
    const snap = await db.collection(cfg.archive).orderBy("archivedAt", "desc").get();
    return snap.docs.map((d) => {
      const out = { [`${cfg.idKey.replace(/ID$/, "Id")}`]: d.id };
      for (const [k, v] of Object.entries(d.data())) out[k] = toISO(v);
      return out;
    });
  };

  const deleteLinkedArchive = async (kind, archiveID) => {
    const cfg = LINKED[kind];
    const ref = db.collection(cfg.archive).doc(archiveID);
    const snap = await ref.get();
    if (!snap.exists) throw new Error(`Archived ${cfg.label} not found.`);
    await ref.delete();
  };

  return {
    collectLinkedForBooking, writeLinkedArchives, linkedLiveRefs,
    restoreLinkedArchives, restoreLinkedForBooking, restoreEntryArchivesBy,
    getLinkedArchiveRefsForBooking, listLinkedArchives, deleteLinkedArchive,
  };
};

export { chunk, uniq, dedupe };
