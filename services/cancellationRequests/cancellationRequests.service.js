// cancellationRequests service -- the ONLY admin-side place that reads/writes
// the cancellationRequests collection (see models/cancellationRequest/cancellationRequest.model.js).
// The customer backend creates rows itself (its own requestCancellation()).
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
 * Map<bookingKey, presentedRequest[]> (newest first) for many bookings.
 * Used by the Bookings list so the detail view can show the customer's reason.
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

/**
 * Map<bookingKey, presentedRequest[]> (newest first) for EVERY request. Volume is
 * tiny (only ongoing trips can request), so one whole-collection read is cheaper
 * than chunked "in" queries for the Bookings list.
 */
export const getAllRequestsMap = async () => {
  const snap = await db.collection(COL).get();
  const all = snap.docs.slice().sort((a, b) => millis(b.data().requestedAt) - millis(a.data().requestedAt));
  const map = new Map();
  all.forEach((d) => {
    const k = d.data().bookingID;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(presentRequest(d));
  });
  return map;
};

/** Marks a request approved/rejected. Pass a Firestore batch to commit it together with other writes. */
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