import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { loadLiveBookingKeys, countsAsRevenue } from "../payments/paymentHelpers.js";
import { resolveVehicleName } from "../booking/booking.service.js";
import { getPayoutsNeedingAttention } from "../depositReturn/depositReturn.service.js";
import { ENTRY_COLLECTION } from "../paymentEntries/paymentEntries.service.js";

// Deposit / discount returns that failed or are still processing at PayMongo (the dashboard raises an alert / warning).
export const getReturnAlerts = () => getPayoutsNeedingAttention();

// Scheduled (same-day payment) refunds for the Dashboard: when each was put on the schedule, when it is sent, and
// whether the automatic send already failed. States:
//   "scheduled" -> waiting for its send time (nothing to do)
//   "due"       -> send time passed, the nightly job has not sent it yet
//   "retry"     -> the automatic send failed with a temporary error: staff press "Retry now" on Refund Requests
//   "failed"    -> PayMongo rejected it for good (request is Failed): hand it back manually
const tsToDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : v ? new Date(v) : null);
export const getScheduledRefunds = async () => {
  const [approvedSnap, failedSnap] = await Promise.all([
    db.collection("refundRequests").where("status", "==", "Approved").get(),
    db.collection("refundRequests").where("status", "==", "Failed").get(),
  ]);
  const docs = [...approvedSnap.docs, ...failedSnap.docs].filter((d) => {
    const r = d.data();
    return r.sendAfter && !r.scheduledSentAt;   // only requests that were scheduled
  });
  const now = Date.now();
  const out = [];
  for (const d of docs) {
    const r = d.data();
    const rows = (await db.collection(ENTRY_COLLECTION).where("refundReqID", "==", d.id).get()).docs.map((x) => x.data());
    const online = rows.filter((v) => v.direction === "out" && v.source === "online" && !v.handBackFor && v.status !== "unrefundable");
    const unsent = online.filter((v) => !v.referenceNumber && v.status !== "success");
    const errorNote = (unsent.find((v) => v.transactionErrorNote) || {}).transactionErrorNote || null;
    // Failed with nothing left unsent = the failure was not a scheduled send: the normal Refund Failed alert covers it.
    if (r.status === "Failed" && !errorNote) continue;
    // Approved and every part already has a PayMongo refund id: it was sent, only the cleanup is missing.
    if (r.status === "Approved" && unsent.length === 0 && online.length > 0) continue;
    const created = online.map((v) => tsToDate(v.createdAt)).filter(Boolean).sort((a, b) => a - b)[0];
    const scheduledAt = tsToDate(r.scheduledAt) || created || tsToDate(r.updatedAt);
    const sendAfter = tsToDate(r.sendAfter);
    const due = sendAfter && sendAfter.getTime() <= now;
    const state = r.status === "Failed" ? "failed" : errorNote && due ? "retry" : due ? "due" : "scheduled";
    out.push({
      refundRequestID: d.id,
      bookingID: r.bookingID || null,
      amount: unsent.length ? unsent.reduce((a, v) => a + (Number(v.amount) || 0), 0) : (r.toRefundAmount ?? r.amount ?? 0),
      state,
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      sendAfter: sendAfter ? sendAfter.toISOString() : null,
      errorNote,
    });
  }
  return out.sort((a, b) => String(a.sendAfter).localeCompare(String(b.sendAfter)));
};

const parsePaymentTotal = (data) => {
  const rental  = parseFloat(data.rentalFee  ?? 0) || 0;
  const service = parseFloat(data.serviceFee ?? 0) || 0;
  const extra   = parseFloat(data.extraFee   ?? 0) || 0;
  return rental + service + extra;
};

const toTimestamp = (date) => admin.firestore.Timestamp.fromDate(date);

export const getTotalVehicles = async () => {
  const snap = await db.collection("cars").get();
  return snap.size;
};

// "approved" and "pending" were retired — bookings go straight to "upcoming"
// at creation now (see the customer backend's bookings.controller.js), the
// only booking-side state that still needs admin attention is a
// cancellation request. These two were silently returning 0 before this fix.
export const getActiveBookings = async () => {
  const snap = await db.collection("bookings").where("status", "==", "upcoming").get();
  return snap.size;
};

export const getPendingBookings = async () => {
  // Pending cancellation requests live in the cancellationRequests table.
  const pending = await db.collection("cancellationRequests").where("status", "==", "pending").get();
  const keys = new Set(pending.docs.filter((d) => !d.data().refundRequestID).map((d) => d.data().bookingID));   // refund-linked rows are counted as refunds
  return keys.size;
};

export const getRevenueToday = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  const live = await loadLiveBookingKeys(db);
  let total = 0;
  snap.forEach((doc) => { const d = doc.data(); if (countsAsRevenue(d, live)) total += parsePaymentTotal(d); });
  return total;
};

export const getMonthlyRevenue = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  const live = await loadLiveBookingKeys(db);
  let total = 0;
  snap.forEach((doc) => { const d = doc.data(); if (countsAsRevenue(d, live)) total += parsePaymentTotal(d); });
  return total;
};

export const getYearlyRevenue = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  const live = await loadLiveBookingKeys(db);
  let total = 0;
  snap.forEach((doc) => { const d = doc.data(); if (countsAsRevenue(d, live)) total += parsePaymentTotal(d); });
  return total;
};

// Same retired-status issue as getActiveBookings/getPendingBookings above —
// "approved" no longer exists. "In use" means a trip is actively underway,
// which is the "ongoing" status now.
export const getVehiclesInUse = async () => {
  const snap = await db.collection("bookings").where("status", "==", "ongoing").get();
  const unique = new Set();
  snap.forEach((doc) => { const id = doc.data().carID; if (id) unique.add(id); });
  return unique.size;
};

export const getRecentBookings = async () => {
  // Fetch only the 20 most recent bookings ordered server-side
  const snap = await db.collection("bookings")
    .orderBy("updatedAt", "desc")
    .limit(20)
    .get();

  const bookings = [];
  snap.forEach((doc) => bookings.push({ id: doc.id, ...doc.data() }));

  // Sort by updatedAt descending
  bookings.sort((a, b) => {
    const ta = a.updatedAt?.toMillis?.() ?? (a.updatedAt ? new Date(a.updatedAt).getTime() : 0);
    const tb = b.updatedAt?.toMillis?.() ?? (b.updatedAt ? new Date(b.updatedAt).getTime() : 0);
    return tb - ta;
  });

  // Collect unique userIDs and carIDs
  const userIDs = [...new Set(bookings.map((b) => b.userID).filter(Boolean))];
  const carIDs  = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];

  // Batch-fetch userDetails only — firstName + lastName
  const detailDocs = await Promise.all(
    userIDs.map((uid) => db.collection("userDetails").doc(uid).get())
  );

  // Build name map: userID → "firstName lastName" (null if both empty)
  const nameMap = {};
  userIDs.forEach((uid, i) => {
    const detail = detailDocs[i];
    if (detail.exists) {
      const { firstName = "", lastName = "" } = detail.data();
      const full = [firstName, lastName].filter(Boolean).join(" ").trim();
      nameMap[uid] = full || null;
    } else {
      nameMap[uid] = null;
    }
  });

  // Build vehicle name map using the same brand+model resolution Bookings.jsx
  // relies on (resolveVehicleName lives in booking.service.js) — keeps the
  // "Car ID" shown here from ever drifting out of sync with the Bookings page.
  const vehicleEntries = await Promise.all(
    carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))
  );
  const vehicleMap = Object.fromEntries(vehicleEntries);

  // Attach customerName + vehicleName to every booking
  return bookings.map((b) => ({
    ...b,
    customerName: nameMap[b.userID] || null,
    vehicleName:  vehicleMap[b.carID] || "—",
  }));
};

export const getDashboardMetrics = async () => {
  const [
    totalVehicles,
    activeBookings,
    pendingBookings,
    revenueToday,
    monthlyRevenue,
    yearlyRevenue,
    vehiclesInUse,
    recentBookings,
  ] = await Promise.all([
    getTotalVehicles(),
    getActiveBookings(),
    getPendingBookings(),
    getRevenueToday(),
    getMonthlyRevenue(),
    getYearlyRevenue(),
    getVehiclesInUse(),
    getRecentBookings(),
  ]);

  return {
    totalVehicles,
    activeBookings,
    pendingBookings,
    revenueToday,
    monthlyRevenue,
    yearlyRevenue,
    vehiclesInUse,
    recentBookings,
    alerts: [],
  };
};