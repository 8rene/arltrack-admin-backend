// cancellationRequests service -- the ONLY admin-side place that reads/writes
// the cancellationRequests collection (see models/cancellationRequests/cancellationRequest.model.js).
// The customer backend creates "request" rows itself (its own requestCancellation()).
// This side writes the "direct" rows (a booking cancelled outright) and resolves requests.
//
// Imports only db, so any service can import it without a circular dependency.
import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const COL = "cancellationRequests";

export const REQUEST_STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected" };

const chunk = (arr, size = 30) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const toIso = (v) => {
  if (!v) return null;
  const d = v.toDate ? v.toDate() : new Date(v._seconds ? v._seconds * 1000 : v);
  return isNaN(d) ? null : d.toISOString();
};

const millis = (v) => {
  if (!v) return 0;
  if (v.toMillis) return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
};

/** Plain, JSON-safe shape sent to the frontend. */
export const presentRequest = (doc) => {
  const d = doc.data ? doc.data() : doc;
  return {
    cancellationRequestID: doc.id || d.cancellationRequestID,
    bookingID:    d.bookingID,
    userID:       d.userID || null,
    reason:       d.reason || "",
    status:       d.status,
    requestedAt:  toIso(d.requestedAt),
    processedBy:  d.processedBy || null,
    processedAt:  toIso(d.processedAt),
    rejectReason: d.rejectReason || null,
    type:         d.type || "request",       // "request" (customer asked mid-trip) | "direct" (cancelled outright)
    cancelledBy:  d.cancelledBy || null,     // direct rows only: customer | staff | admin | system | refund | unknown
  };
};

/** The booking's pending request (as { id, ref, ...data }), or null. */
export const getPendingRequest = async (bookingKey) => {
  if (!bookingKey) return null;
  const snap = await db.collection(COL)
    .where("bookingID", "==", bookingKey)
    .where("status", "==", REQUEST_STATUS.PENDING)
    .limit(1)
    .get();
  return snap.empty ? null : { id: snap.docs[0].id, ref: snap.docs[0].ref, ...snap.docs[0].data() };
};

/** Every pending request (the set that needs staff action). */
export const getAllPendingRequests = async () => {
  const snap = await db.collection(COL).where("status", "==", REQUEST_STATUS.PENDING).get();
  return snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
};

/**
 * Map<bookingKey, presentedRequest[]> (newest first) for many bookings -- every
 * row for those bookings (requests AND direct cancellations). Used by the
 * Bookings list so the detail view can show why a booking was cancelled.
 * Only reads the rows of the bookings asked about (chunked "in" queries), so the
 * cost follows the page size, not the size of the whole collection.
 */
export const getRequestsByBookingKeys = async (bookingKeys) => {
  const keys = [...new Set((bookingKeys || []).filter(Boolean))];
  const map = new Map();
  if (!keys.length) return map;
  const snaps = await Promise.all(
    chunk(keys).map((c) => db.collection(COL).where("bookingID", "in", c).get())
  );
  const all = [];
  snaps.forEach((s) => s.forEach((d) => all.push(d)));
  all.sort((a, b) => millis(b.data().requestedAt) - millis(a.data().requestedAt));
  all.forEach((d) => {
    const k = d.data().bookingID;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(presentRequest(d));
  });
  return map;
};

/** Marks a request approved/rejected. Pass a Firestore batch OR transaction to commit it together with other writes. */
export const resolveRequest = (request, { status, processedBy = null, rejectReason = null }, batch = null) => {
  const patch = {
    status,
    processedBy,
    processedAt: admin.firestore.FieldValue.serverTimestamp(),
    rejectReason: status === REQUEST_STATUS.REJECTED ? (rejectReason || "") : null,
  };
  if (batch) { batch.update(request.ref, patch); return null; }
  return request.ref.update(patch);
};

/**
 * Doc refs of EVERY request row (any status) for a booking. Same purpose as
 * getAssignmentRefsForBooking: used only by the permanent delete of an archived
 * booking, so its rows are not left behind pointing at a booking that is gone.
 */
export const getRequestRefsForBooking = async (bookingKey) => {
  if (!bookingKey) return [];
  const snap = await db.collection(COL).where("bookingID", "==", bookingKey).get();
  return snap.docs.map((d) => d.ref);
};

// -- Direct cancellations ---------------------------------------------------
// Every cancellation reason now lives here (type "direct", status "approved"),
// not on the booking. A customer request that staff approve keeps its own row
// (type "request") and its reason, so approving one adds no second row.

/** Who cancelled, guessed from the reason text. Only used for the migration and for staff/admin/refund writers. */
export const inferCancelledBy = (reason) => {
  const r = String(reason || "");
  if (r.startsWith("Cancelled by staff:")) return "staff";
  if (r.startsWith("Cancelled by admin:")) return "admin";
  if (r.startsWith("Auto-cancelled")) return "system";
  if (r.startsWith("Cancelled: refund")) return "refund";
  if (r === "Cancelled by user.") return "customer";
  return "unknown";
};

/** Writes the cancellation row for a booking that was cancelled outright. Pass a batch to commit it with the booking update. */
export const recordDirectCancellation = (bookingKey, { userID = null, reason = "", cancelledBy = "unknown", processedBy = null } = {}, batch = null) => {
  if (!bookingKey) return null;
  const ref = db.collection(COL).doc(String(bookingKey));
  const now = admin.firestore.FieldValue.serverTimestamp();
  const data = {
    cancellationRequestID: ref.id,
    type: "direct",
    bookingID: bookingKey,
    userID,
    reason: reason || "",
    status: REQUEST_STATUS.APPROVED,
    cancelledBy,
    requestedAt: now,
    processedBy,
    processedAt: now,
    rejectReason: null,
  };
  if (batch) { batch.set(ref, data); return null; }
  return ref.set(data);
};

/** Set of bookingKeys that staff cancelled through the refund/fleet flow. */
export const getStaffCancelledBookingKeys = async () => {
  const snap = await db.collection(COL).where("cancelledBy", "==", "staff").get();
  return new Set(snap.docs.map((d) => d.data().bookingID));
};