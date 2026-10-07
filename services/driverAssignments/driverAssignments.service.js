// driverAssignments service -- the ONLY place that reads/writes the
// driverAssignments collection (see models/driverAssignment/driverAssignment.model.js).
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

/** The key a booking is stored under in driverAssignments.bookingID. */
export const bookingKeyOf = (docID, data = {}) => data.bookingID || docID;

const shape = (doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() });

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

/** Map<bookingKey, assignment> for many bookings at once. */
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
  snaps.forEach((snap) => snap.forEach((d) => map.set(d.data().bookingID, shape(d))));
  return map;
};

/** Every assignment a driver currently holds or has completed (not reassigned/unassigned away). */
export const getAssignmentsForDriver = async (driverID) => {
  if (!driverID) return [];
  const snap = await db.collection(COL)
    .where("driverID", "==", driverID)
    .where("status", "in", [ASSIGNMENT_STATUS.ASSIGNED, ASSIGNMENT_STATUS.COMPLETED])
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
 * ({ id, ...data }) from its current assignment, so everything downstream that
 * still reads `b.driverID` keeps working. A row with no assignment keeps any
 * legacy driverID still sitting on the booking doc (only until the migration's
 * cleanup phase has run). Mutates and returns the same array.
 */
export const attachCurrentDrivers = async (rows) => {
  const map = await getActiveAssignmentsMap(rows.map((b) => bookingKeyOf(b.id, b)));
  rows.forEach((b) => {
    const a = map.get(bookingKeyOf(b.id, b));
    if (a) {
      b.driverID         = a.driverID;
      b.driverAssignedAt = a.assignedAt || null;
      b.driverAssignedBy = a.assignedBy || null;
    }
  });
  return rows;
};

/** Current driver's uid for one booking (assignment first, legacy field as fallback), or null. */
export const resolveCurrentDriverID = async (bookingData, docID) => {
  const a = await getActiveAssignment(bookingKeyOf(docID, bookingData || {}));
  return a?.driverID || bookingData?.driverID || null;
};

// ---------------------------------------------
// Writes
// ---------------------------------------------

/**
 * Puts `driverID` on the booking. Any current assignment is closed as
 * "reassigned" (or left alone if it is already this driver) and a new
 * "assigned" row is created -- in one batch, so a booking never ends up with
 * two current drivers.
 */
export const createAssignment = async ({ bookingKey, driverID, assignedBy }) => {
  const current = await getActiveAssignment(bookingKey);
  if (current && current.driverID === driverID) return current; // nothing to change

  const batch = db.batch();
  if (current) {
    batch.update(current.ref, {
      status: ASSIGNMENT_STATUS.REASSIGNED,
      endedAt: serverNow(),
      endedBy: assignedBy || "admin",
    });
  }
  const ref = db.collection(COL).doc();
  batch.set(ref, {
    assignmentID: ref.id,
    bookingID:    bookingKey,
    driverID,
    status:       ASSIGNMENT_STATUS.ASSIGNED,
    assignedAt:   serverNow(),
    assignedBy:   assignedBy || "admin",
    endedAt:      null,
    endedBy:      null,
  });
  await batch.commit();
  return { id: ref.id, bookingID: bookingKey, driverID };
};

/** Closes the current assignment (default "unassigned"). Returns it, or null if there was none. */
export const endActiveAssignment = async (bookingKey, { status = ASSIGNMENT_STATUS.UNASSIGNED, endedBy = null } = {}) => {
  const current = await getActiveAssignment(bookingKey);
  if (!current) return null;
  await current.ref.update({ status, endedAt: serverNow(), endedBy: endedBy || null });
  return current;
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