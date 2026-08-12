import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveVehicleName } from "../booking/booking.service.js";

const parsePaymentTotal = (data) => {
  const rental  = parseFloat(data.rentalFee  ?? 0) || 0;
  const service = parseFloat(data.serviceFee ?? 0) || 0;
  const deposit = parseFloat(data.depositFee ?? 0) || 0;
  const extra   = parseFloat(data.extrafee   ?? 0) || 0;
  return rental + service + deposit + extra;
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
  const snap = await db.collection("bookings").where("status", "==", "cancellation_request").get();
  return snap.size;
};

export const getRevenueToday = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  let total = 0;
  snap.forEach((doc) => { total += parsePaymentTotal(doc.data()); });
  return total;
};

export const getMonthlyRevenue = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  let total = 0;
  snap.forEach((doc) => { total += parsePaymentTotal(doc.data()); });
  return total;
};

export const getYearlyRevenue = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999));
  const snap = await db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).get();
  let total = 0;
  snap.forEach((doc) => { total += parsePaymentTotal(doc.data()); });
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