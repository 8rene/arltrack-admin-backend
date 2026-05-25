import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

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

export const getActiveBookings = async () => {
  const snap = await db.collection("bookings").where("status", "==", "approved").get();
  return snap.size;
};

export const getPendingBookings = async () => {
  const snap = await db.collection("bookings").where("status", "==", "pending").get();
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

export const getVehiclesInUse = async () => {
  const snap = await db.collection("bookings").where("status", "==", "approved").get();
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

  // Collect unique userIDs
  const userIDs = [...new Set(bookings.map((b) => b.userID).filter(Boolean))];

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

  // Attach customerName to every booking
  return bookings.map((b) => ({
    ...b,
    customerName: nameMap[b.userID] || null,
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
