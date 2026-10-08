// driverAssignments service -- the ONLY place that reads/writes the
// driverAssignments collection (see models/driverAssignments/driverAssignment.model.js).
//
// Intentionally imports nothing from other services (only db), so any service
// can import it without creating a circular dependency.
import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const COL = "driverAssignments";

export const ASSIGNMENT_STATUS = {
  ASSIGNED:   "assigned",
  REASSIGNED: "reassigned",
  UNASSIGNED: "unassigned",
  COMPLETED:  "completed",
};

const serverNow = () => admin.firestore.FieldValue.serverTimestamp();

// Firestore "in" accepts at most 30 values.
const chunk = (arr, size = 30) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const millis = (v) => {
  if (!v) return 0;
  if (v.toMillis) return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** The key a booking is stored under in driverAssignments.bookingID. */
export const bookingKeyOf = (docID, data = {}) => data.bookingID || docID;

const shape = (doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() });

// ---------------------------------------------
// Legacy bookings.driverID
// ---------------------------------------------
// driverAssignments is the ONLY source for "who is driving". Nothing reads
// booking.driverID / driverAssignedAt / driverAssignedBy any more (run
// scripts/migrate-driver-and-cancellation.js --cleanup so no booking doc still
// carries them). Assign / unassign still strip them with the patch below.

/** Booking-doc patch that removes the three legacy driver fields (plus an updatedAt bump). */
export const legacyDriverFieldsPatch = () => ({
  driverID:         admin.firestore.FieldValue.delete(),
  driverAssignedAt: admin.firestore.FieldValue.delete(),
  driverAssignedBy: admin.firestore.FieldValue.delete(),
  updatedAt:        serverNow(),
});

// ---------------------------------------------
// Reads
// ---------------------------------------------

/** The booking's current assignment (status "assigned"), or null. */
export const getActiveAssignment = async (bookingKey) => {
  if (!bookingKey) return null;
  const snap = await db.collection(COL)
    .where("bookingID", "==", bookingKey)
    .where("status", "==", ASSIGNMENT_STATUS.ASSIGNED)
    .limit(1)
    .get();
  return snap.empty ? null : shape(snap.docs[0]);
};

/**
 * Map<bookingKey, assignment> for many bookings at once. If a booking ever has
 * two "assigned" rows (a data problem -- createAssignment closes extras), the
 * most recently assigned one wins instead of whichever the query returned last.
 */
export const getActiveAssignmentsMap = async (bookingKeys) => {
  const keys = [...new Set((bookingKeys || []).filter(Boolean))];
  const map = new Map();
  if (!keys.length) return map;
  const snaps = await Promise.all(
    chunk(keys).map((c) =>
      db.collection(COL)
        .where("bookingID", "in", c)
        .where("status", "==", ASSIGNMENT_STATUS.ASSIGNED)
        .get()
    )
  );
  snaps.forEach((snap) => snap.forEach((d) => {
    const row = shape(d);
    const prev = map.get(row.bookingID);
    if (!prev || millis(row.assignedAt) >= millis(prev.assignedAt)) map.set(row.bookingID, row);
  }));
  return map;
};

/**
 * A driver's assignments in the given statuses. Default is every row that still
 * ties the driver to a trip (assigned + completed). Callers that only need the
 * LIVE trips pass [ASSIGNED] -- a completed row can never belong to an
 * upcoming/ongoing booking, so reading it there is wasted work that grows with
 * the driver's whole history.
 */
export const getAssignmentsForDriver = async (
  driverID,
  statuses = [ASSIGNMENT_STATUS.ASSIGNED, ASSIGNMENT_STATUS.COMPLETED],
) => {
  if (!driverID) return [];
  const snap = await db.collection(COL)
    .where("driverID", "==", driverID)
    .where("status", "in", statuses)
    .get();
  return snap.docs.map(shape);
};

/**
 * Bookings (as { id, ...data }) for a list of booking keys. Keys are normally
 * the business bookingID field; very old bookings without that field are
 * stored under their doc ID, so anything not found by field is tried as a doc ID.
 */
export const getBookingsByKeys = async (bookingKeys) => {
  const keys = [...new Set((bookingKeys || []).filter(Boolean))];
  if (!keys.length) return [];
  const found = new Map(); // key -> { id, ...data }
  const snaps = await Promise.all(
    chunk(keys).map((c) => db.collection("bookings").where("bookingID", "in", c).get())
  );
  snaps.forEach((snap) => snap.forEach((d) => found.set(d.data().bookingID, { id: d.id, ...d.data() })));
  const missing = keys.filter((k) => !found.has(k));
  await Promise.all(missing.map(async (k) => {
    const d = await db.collection("bookings").doc(k).get();
    if (d.exists) found.set(k, { id: d.id, ...d.data() });
  }));
  return [...found.values()];
};

/**
 * Sets driverID / driverAssignedAt / driverAssignedBy on each booking row
 * ({ id, ...data }) from its current assignment. These three fields are a
 * READ-ONLY VIEW for the API consumers that already expect `b.driverID`; they
 * are never written back to the booking doc.
 *
 * A row with no assignment keeps a legacy driverID still sitting on the booking
 * doc; a booking with no current assignment gets null, so such a row is
 * reported as having no driver. Mutates and returns the same array.
 */
export const attachCurrentDrivers = async (rows) => {
  const map = await getActiveAssignmentsMap(rows.map((b) => bookingKeyOf(b.id, b)));
  rows.forEach((b) => {
    const a = map.get(bookingKeyOf(b.id, b));
    if (a) {
      b.driverID         = a.driverID;
      b.driverAssignedAt = a.assignedAt || null;
      b.driverAssignedBy = a.assignedBy || null;
    } else {
      b.driverID         = null;
      b.driverAssignedAt = null;
      b.driverAssignedBy = null;
    }
  });
  return rows;
};

/** Current driver's uid for one booking, from its current assignment, or null. */
export const resolveCurrentDriverID = async (bookingData, docID) => {
  const a = await getActiveAssignment(bookingKeyOf(docID, bookingData || {}));
  if (a?.driverID) return a.driverID;
  return null;
};

// ---------------------------------------------
// Writes
// ---------------------------------------------
// Both writers run in ONE transaction that also carries the caller's booking
// update (bookingRef + bookingPatch), so the assignment row and the booking doc
// can never disagree after a partial failure -- previously the row was written
// first and the booking cleanup ran as a second, separate write.

/**
 * Puts `driverID` on the booking. Any current assignment is closed as
 * "reassigned" (or left alone if it is already this driver) and a new
 * "assigned" row is created, so a booking never ends up with two current
 * drivers. Extra "assigned" rows left by an older bug are closed too.
 *
 * Optional bookingRef + bookingPatch are applied in the same transaction
 * (used to drop the legacy driver fields off the booking doc).
 */
export const createAssignment = async ({ bookingKey, driverID, assignedBy, bookingRef = null, bookingPatch = null }) => {
  const activeQuery = db.collection(COL)
    .where("bookingID", "==", bookingKey)
    .where("status", "==", ASSIGNMENT_STATUS.ASSIGNED);

  return db.runTransaction(async (t) => {
    const active = (await t.get(activeQuery)).docs;
    const alreadyThisDriver = active.length === 1 && active[0].data().driverID === driverID;

    let result;
    if (alreadyThisDriver) {
      result = shape(active[0]); // nothing to change
    } else {
      active.forEach((d) => t.update(d.ref, {
        status:  ASSIGNMENT_STATUS.REASSIGNED,
        endedAt: serverNow(),
        endedBy: assignedBy || "admin",
      }));
      const ref = db.collection(COL).doc();
      t.set(ref, {
        assignmentID: ref.id,
        bookingID:    bookingKey,
        driverID,
        status:       ASSIGNMENT_STATUS.ASSIGNED,
        assignedAt:   serverNow(),
        assignedBy:   assignedBy || "admin",
        endedAt:      null,
        endedBy:      null,
      });
      result = { id: ref.id, bookingID: bookingKey, driverID };
    }
    if (bookingRef && bookingPatch) t.update(bookingRef, bookingPatch);
    return result;
  });
};

/**
 * Closes the current assignment (default "unassigned"). Returns it as it was
 * before closing (so callers can see which driver it was), or null if there was
 * none. Optional bookingRef + bookingPatch are applied in the same transaction,
 * whether or not an assignment existed.
 */
export const endActiveAssignment = async (
  bookingKey,
  { status = ASSIGNMENT_STATUS.UNASSIGNED, endedBy = null, bookingRef = null, bookingPatch = null } = {},
) => {
  const activeQuery = bookingKey
    ? db.collection(COL).where("bookingID", "==", bookingKey).where("status", "==", ASSIGNMENT_STATUS.ASSIGNED)
    : null;

  return db.runTransaction(async (t) => {
    const active = activeQuery ? (await t.get(activeQuery)).docs : [];
    active.forEach((d) => t.update(d.ref, { status, endedAt: serverNow(), endedBy: endedBy || null }));
    if (bookingRef && bookingPatch) t.update(bookingRef, bookingPatch);
    return active.length ? shape(active[0]) : null;
  });
};

/** Marks the current assignment "completed" once the trip is over (completed/cancelled/stolen). Best effort. */
export const completeActiveAssignment = async (bookingKey, endedBy = null) =>
  endActiveAssignment(bookingKey, { status: ASSIGNMENT_STATUS.COMPLETED, endedBy });

/**
 * Doc refs of EVERY assignment row (any status) for a booking. Only used by the
 * permanent delete of an archived booking (archives/bookingArchives.service.js):
 * archiving a booking deliberately leaves its rows here, keyed by bookingID, so a
 * restore reconnects the driver on its own; they are removed only once the
 * archive itself is deleted for good.
 */
export const getAssignmentRefsForBooking = async (bookingKey) => {
  if (!bookingKey) return [];
  const snap = await db.collection(COL).where("bookingID", "==", bookingKey).get();
  return snap.docs.map((d) => d.ref);
};