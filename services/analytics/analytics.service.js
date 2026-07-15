import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// Use the amount field from payments collection directly
const parsePaymentTotal = (data) => {
  return parseFloat(data.amount ?? 0) || 0;
};

const toTimestamp = (date) => admin.firestore.Timestamp.fromDate(date);

// Statuses that count as actual revenue:
// - "approved" -> manually verified payments (bank transfer / cash proof approved by admin)
// - "paid"     -> automated PayMongo payments (GCash, PayMaya, QRPH) confirmed via webhook
const REVENUE_STATUSES = ["approved", "paid"];

export const getDailyAnalytics = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));

  const snap = await db.collection("payments")
    .where("createdAt", ">=", start)
    .where("createdAt", "<=", end)
    .get();

  const hours = Array.from({ length: 24 }, (_, i) => ({
    label: `${i.toString().padStart(2, "0")}:00`,
    revenue: 0,
  }));

  snap.forEach((doc) => {
    const data = doc.data();
    const d = data.createdAt?.toDate?.() || new Date(data.createdAt);
    const h = d.getHours();
    const status = (data.status || "").toLowerCase();
    if (!REVENUE_STATUSES.includes(status)) return;
    if (h >= 0 && h < 24) hours[h].revenue += parsePaymentTotal(data);
  });

  return {
    type: "daily",
    date: now.toISOString().split("T")[0],
    data: hours,
    total: hours.reduce((s, h) => s + h.revenue, 0),
  };
};


export const getWeeklyAnalytics = async () => {
  const now = new Date();
  // Start of this week (Monday)
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMon, 0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const snap = await db.collection("payments")
    .where("createdAt", ">=", toTimestamp(monday))
    .where("createdAt", "<=", toTimestamp(sunday))
    .get();

  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    .map((label) => ({ label, revenue: 0 }));

  snap.forEach((doc) => {
    const data = doc.data();
    const d = data.createdAt?.toDate?.() || new Date(data.createdAt);
    const wd = d.getDay(); // 0=Sun
    const idx = wd === 0 ? 6 : wd - 1; // Mon=0 ... Sun=6
    const status = (data.status || "").toLowerCase();
    if (!REVENUE_STATUSES.includes(status)) return;
    days[idx].revenue += parsePaymentTotal(data);
  });

  return {
    type: "weekly",
    weekStart: monday.toISOString().split("T")[0],
    weekEnd: sunday.toISOString().split("T")[0],
    data: days,
    total: days.reduce((s, d) => s + d.revenue, 0),
  };
};

export const getMonthlyAnalytics = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999));

  const snap = await db.collection("payments")
    .where("createdAt", ">=", start)
    .where("createdAt", "<=", end)
    .get();

  const weeks = Array.from({ length: 5 }, (_, i) => ({ label: `Week ${i + 1}`, revenue: 0 }));

  snap.forEach((doc) => {
    const data = doc.data();
    const d = data.createdAt?.toDate?.() || new Date(data.createdAt);
    const wi = Math.min(Math.floor((d.getDate() - 1) / 7), 4);
    const status = (data.status || "").toLowerCase();
    if (!REVENUE_STATUSES.includes(status)) return;
    weeks[wi].revenue += parsePaymentTotal(data);
  });

  return {
    type: "monthly",
    month: now.toLocaleString("default", { month: "long" }),
    year: now.getFullYear(),
    data: weeks,
    total: weeks.reduce((s, w) => s + w.revenue, 0),
  };
};

export const getYearlyAnalytics = async () => {
  const now = new Date();
  const start = toTimestamp(new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0));
  const end   = toTimestamp(new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999));

  const snap = await db.collection("payments")
    .where("createdAt", ">=", start)
    .where("createdAt", "<=", end)
    .get();

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    .map((label) => ({ label, revenue: 0 }));

  snap.forEach((doc) => {
    const data = doc.data();
    const d = data.createdAt?.toDate?.() || new Date(data.createdAt);
    const status = (data.status || "").toLowerCase();
    if (!REVENUE_STATUSES.includes(status)) return;
    months[d.getMonth()].revenue += parsePaymentTotal(data);
  });

  return {
    type: "yearly",
    year: now.getFullYear(),
    data: months,
    total: months.reduce((s, m) => s + m.revenue, 0),
  };
};
