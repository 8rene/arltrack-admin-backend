import { db } from "../../config/firebaseConnection/firebase.js";
import { getEntriesForPaymentIDs, getEntriesForPenaltyIDs } from "../paymentEntries/paymentEntries.service.js";
import { hydratePayment } from "../paymentEntries/paymentEntries.mapper.js";
import { computeAmounts, normalizePaymentStatus, derivePaymentStage } from "../payments/payments.service.js";
import { getDepositView } from "../payments/paymentHelpers.js";
import { ENTRY_COLLECTION } from "../../models/paymentEntries/paymentEntry.model.js";
import { resolveUserName, resolveUserNames } from "../archives/resolveUserName.service.js";
import { resolveRoleID } from "../../utils/roles/role.util.js";

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS
//
// Same rules as the mobile app's Reports tab (lib/services/reports_service.dart), built on the admin's own
// payment code so the numbers match the Payments page:
//
//   MONEY      payments.amount is the booking's GRAND TOTAL, never "paid so far". Every peso figure comes from
//              computeAmounts() (the same function the Payments page uses) on the payment as hydrated from its
//              paymentEntries rows. Refunds are the settled "out" rows of paymentEntries.
//   PAYMENTS   dated by when they were made (createdAt).
//   RENTALS    dated by when the trip STARTS (startDateTime). Only Upcoming / Ongoing / Completed / Cancelled
//              bookings count ("to pay" and anything unrecognised never do). (Rentals & Customers tab only.)
//   REVENUE    (Revenue & Expense tab) counted ONLY for bookings that are OVER, on the day they ended:
//                completed  -> the day the booking was completed (completedAt), even while its deposit is still held
//                              (a held deposit is not revenue; the part you keep is added when the deposit is settled)
//                cancelled  -> the cancellation day
//                stolen     -> the day it was flagged stolen
//              Upcoming, ongoing and to-pay bookings are NOT counted yet.
//   EXPENSE    Completed maintenance, dated by its maintenanceDate; PayMongo fees follow their booking's finalization day.
//   CUSTOMERS  users whose role is Customer, dated by their sign-up (createdAt).
// ─────────────────────────────────────────────────────────────────────────────

const toDate = (val) => {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (val?._seconds) return new Date(val._seconds * 1000);
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const num = (v) => Number(v) || 0;
const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

/**
 * Builds the date range for a report.
 *
 * All selections (year / month / week / day) are EXPLICIT and come from the user via the Reports tab dropdowns.
 * `refDate` is only a last-resort fallback if a value is missing.
 *
 * @param {string} period  daily | weekly | monthly | yearly
 * @param {object} sel     { year, month, week, day } — all 1-based, month 1-12
 */
const getRange = (period, sel = {}, refDate = new Date()) => {
  const y = Number(sel.year)  || refDate.getFullYear();
  const m = (sel.month ? Number(sel.month) - 1 : refDate.getMonth()); // 0-based
  const d = Number(sel.day)   || refDate.getDate();

  if (period === "daily") {
    const start = new Date(y, m, d, 0, 0, 0, 0);
    const end   = new Date(y, m, d, 23, 59, 59, 999);
    return { start, end, label: start.toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric" }) };
  }

  if (period === "weekly") {
    // Month is split into fixed 7-day buckets: Week 1 = days 1-7, Week 2 = 8-14,
    // Week 3 = 15-21, Week 4 = 22-28, Week 5 = 29-end of month.
    const week = Number(sel.week) || 1;
    const lastDayOfMonth = new Date(y, m + 1, 0).getDate();

    const startDay = Math.min((week - 1) * 7 + 1, lastDayOfMonth);
    const endDay    = Math.min(week * 7, lastDayOfMonth);

    const start = new Date(y, m, startDay, 0, 0, 0, 0);
    const end   = new Date(y, m, endDay, 23, 59, 59, 999);
    return {
      start,
      end,
      label: `Week ${week} · ${start.toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}`,
    };
  }

  if (period === "monthly") {
    const start = new Date(y, m, 1, 0, 0, 0, 0);
    const end   = new Date(y, m + 1, 0, 23, 59, 59, 999);
    return { start, end, label: start.toLocaleDateString("en-PH", { month: "long", year: "numeric" }) };
  }

  if (period === "yearly") {
    const start = new Date(y, 0, 1, 0, 0, 0, 0);
    const end   = new Date(y, 11, 31, 23, 59, 59, 999);
    return { start, end, label: String(y) };
  }

  throw new Error("Invalid period.");
};

// ── BOOKINGS ────────────────────────────────────────────────────────────────

// Old and new vocabularies both resolve: pending → "to pay", confirmed → "upcoming", canceled → "cancelled".
const normalizeBookingStatus = (raw) => {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "pending")   return "to pay";
  if (s === "confirmed") return "upcoming";
  if (s === "canceled")  return "cancelled";
  return s;
};
const COUNTED_STATUSES = new Set(["completed", "cancelled", "upcoming", "ongoing"]);

/** Bookings whose trip STARTS inside the period, confirmed ones only. */
const loadBookingsInRange = async (start, end) => {
  const snap = await db.collection("bookings")
    .where("startDateTime", ">=", start)
    .where("startDateTime", "<=", end)
    .get();
  return snap.docs
    .map((d) => {
      const b = d.data();
      return {
        id: d.id,
        bookingID: b.bookingID || d.id,
        userID: b.userID || null,
        carID: b.carID || null,
        modeOfDriving: b.modeOfDriving || "",
        serviceTypeID: b.serviceTypeID || null,
        status: normalizeBookingStatus(b.status),
        location: b.location || "—",
        totalDays: b.totalDays || 0,
        startDateTime: toDate(b.startDateTime || b.startDate),
        endDateTime: toDate(b.endDateTime || b.endDate),
        createdAt: toDate(b.createdAt),
      };
    })
    .filter((b) => COUNTED_STATUSES.has(b.status));
};

/** Any bookings (a payment made in the period can belong to a trip outside it) by document id. */
const loadBookingsByIDs = async (ids) => {
  const out = {};
  for (const part of chunk(uniq(ids), 100)) {
    const docs = await db.getAll(...part.map((id) => db.collection("bookings").doc(String(id))));
    docs.forEach((doc) => {
      if (!doc.exists) return;
      const b = doc.data();
      out[doc.id] = {
        keys: uniq([doc.id, b.bookingID]),
        carID: b.carID || null, userID: b.userID || null, status: normalizeBookingStatus(b.status),
        tripStart: toDate(b.startDateTime || b.startDate), cancelledAt: toDate(b.cancelledAt), updatedAt: toDate(b.updatedAt),
        completedAt: toDate(b.completedAt), stolenAt: toDate(b.stolenAt),
      };
      if (b.bookingID) out[b.bookingID] = out[doc.id];
    });
  }
  return out;
};

// ── BOOKING FINALIZATION (what decides WHEN a booking's money becomes revenue) ──

/** Payments of the given bookings (by document id or bookingID field). */
const loadPaymentsByBookingKeys = async (keys) => {
  const out = [];
  for (const part of chunk(uniq(keys), 30)) {
    const snap = await db.collection("payments").where("bookingID", "in", part).get();
    snap.docs.forEach((d) => out.push({ id: d.id, ...d.data() }));
  }
  return out;
};

/**
 * Stamps `finalizedAt` on every booking in the map: the day its revenue is recorded, or null while the booking is not over.
 *   completed  the day it was completed (the trip ended). A security deposit that is still held does NOT delay it: a held
 *              deposit is already left out of revenue, and the part you keep is added on the day the deposit is settled.
 *   cancelled  the cancellation day (cancelledAt, else the booking's last update, which is what the cancel sets).
 *   stolen     the day it was flagged (stolenAt, else the last update; a stolen booking can no longer be edited).
 *   anything else (to pay / upcoming / ongoing / unknown)  null: never revenue.
 */
const finalizeBookings = (bookingMap) => {
  const list = [...new Set(Object.values(bookingMap))];
  list.forEach((b) => {
    if (b.status === "cancelled") { b.finalizedAt = b.cancelledAt || b.updatedAt || b.tripStart || null; return; }
    if (b.status === "stolen") { b.finalizedAt = b.stolenAt || b.updatedAt || null; return; }
    if (b.status !== "completed") { b.finalizedAt = null; return; }
    b.finalizedAt = b.completedAt || b.updatedAt || b.tripStart || null;
  });
};

// ── PAYMENTS ────────────────────────────────────────────────────────────────

/**
 * One payment plus everything the report needs to know about its money, worked out ONCE with the Payments
 * page's own rules.
 *   status        Approved | Pending | Rejected | Refunded | Cancelled | Failed
 *   collected     money really received so far (only a confirmed payment counts)
 *   outstanding   still to come in: the unpaid balance of a confirmed / pending payment
 *   refunded      money actually handed back: settled "out" rows of paymentEntries
 */
const buildPaymentViews = (paymentDocs, entriesByPayment, bookingMap) => paymentDocs.map((raw) => {
  const key = raw.paymentID || raw.originalId || raw.id;
  const entries = entriesByPayment.get(key) || [];
  const p = hydratePayment(raw, entries, { rowsOnly: true });
  const booking = bookingMap[p.bookingID] || null;

  // A cancelled booking always reads "Cancelled" — except a payment that really was refunded.
  let status = normalizePaymentStatus(p.status);
  if (booking?.status === "cancelled" && status !== "Refunded") status = "Cancelled";

  const { amountPaid, balance, payType } = computeAmounts(p);

  let refunded = entries
    .filter((e) => e.direction === "out" && e.status === "success")
    .reduce((s, e) => s + num(e.amount), 0);
  // Payments refunded before paymentEntries existed have no "out" rows: fall back to the whole amount.
  if (refunded === 0 && entries.length === 0 && String(raw.status || "").toLowerCase() === "refunded") refunded = num(raw.amount);

  const confirmed = status === "Approved";
  return {
    p, entries, status, payType, amountPaid, balance, refunded,
    carID: booking?.carID || null,
    userID: booking?.userID || null,
    createdAt: toDate(p.createdAt),
    collected: confirmed ? amountPaid : 0,
    outstanding: (status === "Approved" || status === "Pending") ? Math.max(0, balance) : 0,
    confirmed,
  };
});

// Cash and GCash get their own rows; Maya, QR Ph, bank transfer ... are rolled into "Other".
const methodBucket = (method) => {
  const lower = String(method ?? "").trim().toLowerCase();
  if (lower === "cash") return "Cash";
  if (lower === "gcash") return "GCash";
  return "Other";
};

/**
 * Payment-method breakdown. Money is attributed by the paymentEntries that actually moved it, so a payment paid
 * in two steps (deposit online, balance in cash) shows under BOTH methods, one transaction each. Only confirmed
 * payments count. A payment with no entries (legacy) falls back to its own paymentMethod and its collected amount.
 */
const buildPaymentReport = (views) => {
  const count = { Cash: 0, GCash: 0, Other: 0 };
  const amount = { Cash: 0, GCash: 0, Other: 0 };
  const add = (bucket, value) => { count[bucket] += 1; amount[bucket] += value; };

  for (const v of views) {
    if (!v.confirmed) continue;
    const received = v.entries.filter((e) => e.direction === "in" && e.status === "success" && (e.phase === "deposit" || e.phase === "balance"));
    if (received.length === 0) {
      if (v.collected > 0) add(methodBucket(v.p.paymentMethod), v.collected);
      continue;
    }
    received.forEach((e) => add(methodBucket(e.method), num(e.amount)));
  }

  return {
    totalPayments: views.length,
    byMethod: ["Cash", "GCash", "Other"].filter((k) => count[k] > 0).map((k) => ({ method: k, count: count[k], amount: amount[k] })),
  };
};

// ── RENTALS ─────────────────────────────────────────────────────────────────

const buildRentalReport = (bookings) => {
  const now = new Date();
  let completed = 0, ongoing = 0, upcoming = 0, cancelled = 0;
  for (const b of bookings) {
    if (b.status === "completed") completed++;
    else if (b.status === "cancelled") cancelled++;
    else if (b.status === "ongoing") ongoing++;   // set once before-trip documentation is done: already in progress
    else if (b.status === "upcoming") {
      // Deposit cleared: in progress right now vs. still ahead of its start date.
      const started = b.startDateTime ? b.startDateTime <= now : false;
      const ended   = b.endDateTime ? b.endDateTime < now : false;
      if (started && !ended) ongoing++;
      else if (!started) upcoming++;
    }
  }
  return { totalRentals: bookings.length, completed, ongoing, upcoming, cancelled };
};

// ── BOOKING DISPLAY STATUS ──────────────────────────────────────────────────

/** completed | ongoing | upcoming | cancelled — same rules as buildRentalReport. null = counted by none of the four. */
const displayStatusOf = (b, now = new Date()) => {
  if (b.status === "completed") return "completed";
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "ongoing") return "ongoing";
  if (b.status === "upcoming") {
    const started = b.startDateTime ? b.startDateTime <= now : false;
    const ended   = b.endDateTime ? b.endDateTime < now : false;
    if (started && !ended) return "ongoing";
    if (!started) return "upcoming";
  }
  return null;
};

// ── VEHICLES ────────────────────────────────────────────────────────────────

/**
 * Brand + model names for a set of carIDs (cars only store brandID / modelID).
 */
/** Payments by paymentID (doc id first, then the paymentID field for the few that differ). */
const loadPaymentsByIDs = async (ids) => {
  const list = uniq(ids);
  const out = {};
  for (const part of chunk(list, 100)) {
    const docs = await db.getAll(...part.map((id) => db.collection("payments").doc(String(id))));
    docs.forEach((d) => { if (d.exists) out[d.id] = d.data(); });
  }
  for (const part of chunk(list.filter((id) => !out[id]), 30)) {
    const snap = await db.collection("payments").where("paymentID", "in", part).get();
    snap.docs.forEach((d) => { const k = d.data().paymentID; if (k) out[k] = d.data(); });
  }
  return out;
};

/**
 * What one rental money-in entry was FOR. The booking's fees are saved on the payment (rental, service fee, gateway fee,
 * refundable security deposit; all inside `amount`), while money arrives in steps. So: the first ("deposit") step pays the
 * security deposit first; whatever is left of the step is split between rental / service fee / gateway fee in proportion
 * to the booking's own figures. The parts always add up to the entry, so they add up to Money in.
 * Exact for a booking paid in full; proportional when only part of it has been paid.
 */
const splitRentalEntry = (f, p) => {
  const e = f.amount;
  const r2 = (n) => Math.round(n * 100) / 100;
  if (!p) return { rental: e, service: 0, gateway: 0, deposit: 0 };
  const amount = num(p.amount);
  const sd = Math.min(Math.max(0, num(p.securityDeposit) || num(p.deposit && p.deposit.amount)), Math.max(0, amount));
  const deposit = f.phase === "deposit" ? Math.min(sd, e) : 0;
  const rest = e - deposit;
  const W = amount - sd;
  if (!(W > 0) || !(rest > 0)) return { rental: rest, service: 0, gateway: 0, deposit };
  const sf = Math.min(Math.max(0, num(p.serviceFee)), W);
  const gf = Math.min(Math.max(0, num(p.gatewayFee)), W - sf);
  const service = r2(rest * sf / W), gateway = r2(rest * gf / W);
  return { rental: r2(rest - service - gateway), service, gateway, deposit };
};

/** serviceTypeID -> name, looked up once per service type. The collection's field is `serviceType`. */
const resolveServiceTypeNames = async (ids) => {
  if (ids.length === 0) return {};
  const docs = await db.getAll(...ids.map((id) => db.collection("serviceType").doc(String(id))));
  const out = {};
  docs.forEach((doc) => { if (doc.exists) out[doc.id] = doc.data().serviceType || ""; });
  return out;
};

const resolveVehicleNames = async (carIDs) => {
  if (carIDs.length === 0) return {};

  const carDocs = await db.getAll(...carIDs.map((id) => db.collection("cars").doc(id)));
  const brandIDs = new Set();
  const modelIDs = new Set();
  const carData = {};
  carDocs.forEach((doc) => {
    if (!doc.exists) return;
    const data = doc.data();
    carData[doc.id] = data;
    if (data.brandID) brandIDs.add(data.brandID);
    if (data.modelID) modelIDs.add(data.modelID);
  });

  const [brandDocs, modelDocs] = await Promise.all([
    brandIDs.size ? db.getAll(...[...brandIDs].map((id) => db.collection("brand").doc(id))) : [],
    modelIDs.size ? db.getAll(...[...modelIDs].map((id) => db.collection("model").doc(id))) : [],
  ]);
  const brandMap = Object.fromEntries(brandDocs.map((d) => [d.id, d.exists ? d.data().brandName : null]));
  const modelMap = Object.fromEntries(modelDocs.map((d) => [d.id, d.exists ? d.data().modelName : null]));

  const names = {};
  carIDs.forEach((carID) => {
    const c = carData[carID];
    if (!c) { names[carID] = "Unknown Vehicle"; return; }
    names[carID] = [brandMap[c.brandID], modelMap[c.modelID]].filter(Boolean).join(" ") || "Unknown Vehicle";
  });
  return names;
};

/**
 * Rentals per car come from the period's bookings; revenue per car is the money collected on that car's bookings'
 * payments (a payment made in the period can belong to a trip outside it, hence the booking lookup).
 */
const buildVehicleReport = async (bookings, views, extraCarIDs = []) => {
  const rentalCount = {};
  bookings.forEach((b) => { if (b.carID) rentalCount[b.carID] = (rentalCount[b.carID] || 0) + 1; });

  const revenueByCar = {};
  views.forEach((v) => { if (v.carID && v.collected > 0) revenueByCar[v.carID] = (revenueByCar[v.carID] || 0) + v.collected; });

  const rentedCarIDs = Object.keys(rentalCount);
  if (rentedCarIDs.length === 0) {
    return { totalVehiclesRented: 0, revenuePerVehicle: 0, mostRented: null, leastRented: null, topVehicles: [], ranking: [] };
  }

  const names = await resolveVehicleNames(uniq([...rentedCarIDs, ...extraCarIDs]));
  const entryFor = (carID) => ({ carID, name: names[carID] || "Unknown Vehicle", rentals: rentalCount[carID] || 0, revenue: revenueByCar[carID] || 0 });
  const ranking = rentedCarIDs.map(entryFor).sort((a, b) => b.rentals - a.rentals);

  const totalRevenue = Object.values(revenueByCar).reduce((s, v) => s + v, 0);
  return {
    totalVehiclesRented: rentedCarIDs.length,
    revenuePerVehicle: Math.round(totalRevenue / rentedCarIDs.length),
    mostRented: ranking[0],
    leastRented: ranking[ranking.length - 1],
    topVehicles: ranking.slice(0, 10),
    ranking,
  };
};

// ── CUSTOMERS ───────────────────────────────────────────────────────────────

/** Every Customer-role user, with only the sign-up date read. */
const loadCustomers = async () => {
  const roleID = await resolveRoleID("Customer");
  if (!roleID) return [];
  const snap = await db.collection("user").where("roleID", "==", roleID).select("createdAt").get();
  return snap.docs.map((d) => ({ id: d.id, createdAt: toDate(d.data().createdAt) }));
};

/**
 * totalCustomers  Customers registered by the END of the period.
 * newCustomers    Customers who signed up INSIDE the period.
 * topCustomers    Top 10 by money collected from their payments in the period.
 */
const buildCustomerReport = async (customers, bookings, views, start, end) => {
  const registered = customers.filter((c) => !c.createdAt || c.createdAt <= end).length;
  const newCustomers = customers.filter((c) => c.createdAt && c.createdAt >= start && c.createdAt <= end).length;

  const rentalsByUser = {};
  bookings.forEach((b) => { if (b.userID) rentalsByUser[b.userID] = (rentalsByUser[b.userID] || 0) + 1; });

  const spendByUser = {};
  views.forEach((v) => { if (v.userID && v.collected > 0) spendByUser[v.userID] = (spendByUser[v.userID] || 0) + v.collected; });

  const ranked = Object.entries(spendByUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const names = await Promise.all(ranked.map(([userID]) => resolveUserName(userID).catch(() => "Unknown")));

  return {
    totalCustomers: registered,
    newCustomers,
    topCustomers: ranked.map(([userID, spend], i) => ({
      userID,
      name: names[i] && names[i] !== "—" ? names[i] : "Unknown",
      amountPaid: spend,
      rentals: rentalsByUser[userID] || 0,
    })),
  };
};

// ── MAINTENANCE EXPENSE ─────────────────────────────────────────────────────

/** Completed maintenance in the period, newest first. Only Completed records are an expense. */
const loadMaintenanceExpenses = async (start, end) => {
  const snap = await db.collection("maintenance").where("status", "in", ["Completed", "completed"]).get();
  const rows = [];
  snap.docs.forEach((d) => {
    const m = d.data();
    const date = toDate(m.maintenanceDate) || toDate(m.createdAt) || toDate(m.updatedAt);
    if (!date || date < start || date > end) return;
    rows.push({
      id: d.id,
      carID: m.carID || null,
      date,
      basis: m.basis || "",
      services: (m.services || []).map((s) => s.serviceName).filter(Boolean).join(", "),
      amount: num(m.totalCost),
    });
  });
  const names = await resolveVehicleNames(uniq(rows.map((r) => r.carID)));
  return rows
    .sort((a, b) => b.date - a.date)
    .map((r) => ({ id: r.id, carID: r.carID, date: r.date.toISOString(), carName: names[r.carID] || "Unknown Vehicle", basis: r.basis, services: r.services, amount: r.amount }));
};

/**
 * Maintenance that is still Scheduled (not done yet) with its date inside the period, so a car's upcoming cost can be shown next
 * to what was completed. It is never part of the maintenance expense: only a Completed job is.
 */
const loadScheduledMaintenance = async (start, end) => {
  const snap = await db.collection("maintenance").where("status", "in", ["Scheduled", "scheduled"]).get();
  const rows = [];
  snap.docs.forEach((d) => {
    const m = d.data();
    const date = toDate(m.maintenanceDate);
    if (!date || date < start || date > end) return;
    rows.push({ id: d.id, carID: m.carID || null, date, basis: m.basis || "", services: (m.services || []).map((x) => x.serviceName).filter(Boolean).join(", "), amount: num(m.totalCost) });
  });
  const names = await resolveVehicleNames(uniq(rows.map((r) => r.carID)));
  return rows.map((r) => ({ ...r, carName: names[r.carID] || "Unknown Vehicle" }));
};

// ── TOTALS PER DAY / WEEK / MONTH / YEAR ────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthShort = (m) => MONTHS[m].slice(0, 3);

const bucketStart = (g, d) => {
  if (g === "day")   return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (g === "week")  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));   // weeks run Monday to Sunday
  if (g === "month") return new Date(d.getFullYear(), d.getMonth(), 1);
  return new Date(d.getFullYear(), 0, 1);
};

// "Sep 30, 2026", "Sep 28 – Oct 4, 2026", "September 2026", "2026"
const bucketLabel = (g, s) => {
  if (g === "day")   return `${monthShort(s.getMonth())} ${s.getDate()}, ${s.getFullYear()}`;
  if (g === "month") return `${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
  if (g === "year")  return String(s.getFullYear());
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
  const left = `${monthShort(s.getMonth())} ${s.getDate()}`;
  const right = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear() ? `${e.getDate()}` : `${monthShort(e.getMonth())} ${e.getDate()}`;
  return `${left} – ${right}, ${e.getFullYear()}`;
};

/**
 * Rentals / completed / cancelled / vehicles rented — bookings that START in the bucket.
 * Sales / pending / refunded — payments made in the bucket. New customers — sign-ups in the bucket.
 * Only buckets that had activity are listed, newest first.
 */
const buildPeriodTotals = (bookings, views, customersInPeriod) => {
  const result = {};
  for (const g of ["day", "week", "month", "year"]) {
    const acc = new Map();
    const at = (d) => {
      const s = bucketStart(g, d);
      const k = s.getTime();
      if (!acc.has(k)) acc.set(k, { start: s, sales: 0, pending: 0, refunded: 0, payments: 0, rentals: 0, completed: 0, cancelled: 0, newCustomers: 0, cars: new Set() });
      return acc.get(k);
    };
    bookings.forEach((b) => {
      if (!b.startDateTime) return;
      const a = at(b.startDateTime);
      a.rentals++;
      if (b.status === "completed") a.completed++;
      if (b.status === "cancelled") a.cancelled++;
      if (b.carID) a.cars.add(b.carID);
    });
    views.forEach((v) => {
      if (!v.createdAt) return;
      const a = at(v.createdAt);
      a.payments++; a.sales += v.collected; a.pending += v.outstanding; a.refunded += v.refunded;
    });
    customersInPeriod.forEach((c) => { if (c.createdAt) at(c.createdAt).newCustomers++; });

    result[g] = [...acc.values()]
      .sort((a, b) => b.start - a.start)
      .map((a) => ({
        start: a.start.toISOString(),
        label: bucketLabel(g, a.start),
        sales: a.sales, pending: a.pending, refunded: a.refunded,
        totalRevenue: a.sales + a.pending,          // paid + pending; refunded is not part of it
        payments: a.payments, rentals: a.rentals, completed: a.completed, cancelled: a.cancelled,
        newCustomers: a.newCustomers, vehiclesRented: a.cars.size,
      }));
  }
  return result;
};

// ── THE REPORT ──────────────────────────────────────────────────────────────

export const generateReport = async (period, selection = {}) => {
  const { start, end, label } = getRange(period, selection);

  const [bookings, paySnap, maintenanceExpenses, customers] = await Promise.all([
    loadBookingsInRange(start, end),
    db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt", "asc").get(),
    loadMaintenanceExpenses(start, end),
    loadCustomers(),
  ]);

  const paymentDocs = paySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const entriesByPayment = await getEntriesForPaymentIDs(paymentDocs.map((p) => p.paymentID || p.originalId || p.id));

  // A payment's booking (status / car / customer) may start outside the period, so look the rest up by id.
  const bookingMap = await loadBookingsByIDs(paymentDocs.map((p) => p.bookingID));
  bookings.forEach((b) => { bookingMap[b.id] = bookingMap[b.id] || { carID: b.carID, userID: b.userID, status: b.status }; });

  const views = buildPaymentViews(paymentDocs, entriesByPayment, bookingMap);

  // ── money ──
  const grossSales = views.reduce((s, v) => s + v.collected, 0);
  const pendingAmount = views.reduce((s, v) => s + v.outstanding, 0);
  const refundedAmount = views.reduce((s, v) => s + v.refunded, 0);
  const maintenanceExpense = maintenanceExpenses.reduce((s, m) => s + m.amount, 0);
  const totalSales = grossSales - maintenanceExpense;     // money received minus Completed maintenance; refunds are NOT deducted
  const numberOfRentals = bookings.length;

  const [vehicleReport, customerReport] = await Promise.all([
    buildVehicleReport(bookings, views),
    buildCustomerReport(customers, bookings, views, start, end),
  ]);

  const paymentReport = buildPaymentReport(views);
  const rentalReport = buildRentalReport(bookings);
  const periodTotals = buildPeriodTotals(bookings, views, customers.filter((c) => c.createdAt && c.createdAt >= start && c.createdAt <= end));

  /* ── detail tables ── */
  const paymentRows = views.map((v) => ({
    id: v.p.id,
    paymentID: v.p.paymentID || v.p.id,
    bookingID: v.p.bookingID || "—",
    amount: num(v.p.amount),                   // the booking's grand total
    amountPaid: v.amountPaid,
    balance: v.balance,
    refunded: v.refunded,
    status: v.status,
    methodOfPayment: v.p.methodOfPayment || "—",
    paymentMethod: v.p.paymentMethod || "—",
    referenceNumber: v.p.paymongoPaymentID || "—",   // latest PayMongo charge id, from the entries
    createdAt: v.createdAt ? v.createdAt.toISOString() : null,
  }));

  // Car and customer names for the Rentals & Customers tab (looked up once per car / customer).
  const rowCarIDs = uniq(bookings.map((b) => b.carID).filter(Boolean));
  const rowUserIDs = uniq(bookings.map((b) => b.userID).filter(Boolean));
  const rowServiceTypeIDs = uniq(bookings.map((b) => b.serviceTypeID).filter(Boolean));
  const [rowCarNames, rowUserNames, rowServiceTypeNames] = await Promise.all([
    resolveVehicleNames(rowCarIDs),
    Promise.all(rowUserIDs.map((id) => resolveUserName(id).catch(() => "Unknown"))),
    resolveServiceTypeNames(rowServiceTypeIDs).catch(() => ({})),
  ]);
  const customerNameByID = Object.fromEntries(rowUserIDs.map((id, i) => [id, rowUserNames[i] && rowUserNames[i] !== "—" ? rowUserNames[i] : "Unknown"]));
  const reportNow = new Date();

  const totalByBookingID = {};
  views.forEach((v) => { if (v.p.bookingID) totalByBookingID[v.p.bookingID] = num(v.p.amount); });
  const bookingRows = bookings
    .slice()
    .sort((a, b) => (a.startDateTime || 0) - (b.startDateTime || 0))
    .map((b) => ({
      id: b.id,
      bookingID: b.bookingID,
      carID: b.carID,
      carName: b.carID ? (rowCarNames[b.carID] || "Unknown Vehicle") : "Unknown Vehicle",
      userID: b.userID,
      customerName: b.userID ? (customerNameByID[b.userID] || "Unknown") : "Unknown",
      modeOfDriving: b.modeOfDriving || "",
      serviceTypeID: b.serviceTypeID,
      serviceTypeName: (b.serviceTypeID && rowServiceTypeNames[b.serviceTypeID]) || "Unspecified",
      status: b.status,
      displayStatus: displayStatusOf(b, reportNow),
      location: b.location,
      totalFee: totalByBookingID[b.bookingID] || 0,
      totalDays: b.totalDays,
      startDate: b.startDateTime ? b.startDateTime.toISOString() : null,
      endDate: b.endDateTime ? b.endDateTime.toISOString() : null,
      createdAt: b.createdAt ? b.createdAt.toISOString() : null,
    }));

  const bookingsByStatus = {};
  bookings.forEach((b) => { bookingsByStatus[b.status] = (bookingsByStatus[b.status] || 0) + 1; });

  return {
    period,
    label,
    generatedAt: new Date().toISOString(),
    range: { start: start.toISOString(), end: end.toISOString() },

    // Top-of-page cards. totalSales = money received − completed maintenance (refunds not deducted).
    topStats: {
      totalSales,
      grossSales,
      refundedAmount,
      maintenanceExpense,
      numberOfRentals,
      averageSale: numberOfRentals > 0 ? Math.round(grossSales / numberOfRentals) : 0,
    },

    // Completed maintenance in the period (the expense deducted above), newest first.
    maintenanceExpenses,

    // totalRevenue = paid + pending. Refunds are shown but are not part of it.
    revenueReport: {
      totalRevenue: grossSales + pendingAmount,
      paidAmount: grossSales,
      pendingAmount,
      refundedAmount,
    },

    rentalReport,
    vehicleReport,
    customerReport,
    paymentReport,
    periodTotals,

    // Kept for backwards compatibility / legacy summary consumers
    summary: {
      totalRevenue: grossSales + pendingAmount,
      totalPaid: grossSales,
      totalBalance: pendingAmount,
      totalPayments: paymentRows.length,
      totalBookings: numberOfRentals,
      avgRevenuePerBooking: numberOfRentals > 0 ? Math.round((grossSales + pendingAmount) / numberOfRentals) : 0,
    },
    paymentsByGateway: Object.fromEntries(paymentReport.byMethod.map((m) => [m.method, m.amount])),
    bookingsByStatus,
    payments: paymentRows,
    bookings: bookingRows,
  };
};

// ── MAINTENANCE & PENALTIES ─────────────────────────────────────────────────

/**
 * Maintenance & Penalties report for the Summary page.
 *
 *   Maintenance   Completed maintenance in the period (same rule as the expense on the revenue report).
 *   Scheduled     Maintenance still Scheduled with its date in the period: shown beside the cost (cars[].scheduled), never added to it.
 *   Penalties     Confirmed penalties created in the period. Under review / discarded / voided / waived ones are
 *                 not charges, so they are left out. Paid = paidAmount (capped at the amount); pending = the rest.
 *
 *   cars          one row per car WITH maintenance: total cost, split into recovered (penalties collected on that
 *                 car, capped at its maintenance cost) and absorbed (the rest). Needs no repair-to-penalty link.
 *   penaltyRows   one row per Confirmed penalty (customer, car, amount, paid, pending): what the Reports page groups.
 *   customers     one row per customer + car pair, sorted / searched / paged here (older page layout; kept for compatibility).
 *
 * @param {object} opts { sort: "total" | "unpaid", search, page, pageSize }
 */
export const generateMaintenancePenaltiesReport = async (period, selection = {}, opts = {}) => {
  const { start, end, label } = getRange(period, selection);
  const sort = opts.sort === "unpaid" ? "unpaid" : "total";
  const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 5, 1), 50);
  const search = String(opts.search || "").trim().toLowerCase();
  const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
  const lowerS = (v) => String(v ?? "").trim().toLowerCase();

  const [penSnap, confirmedSnap, entrySnap] = await Promise.all([
    db.collection("penalties").where("createdAt", ">=", start).where("createdAt", "<=", end).get(),
    db.collection("penalties").where("status", "==", "Confirmed").get(),                       // every Confirmed penalty: "Unpaid now" looks at all periods
    db.collection(ENTRY_COLLECTION).where("settledAt", ">=", start).where("settledAt", "<=", end).get(),   // same rows Money in is made of
  ]);

  const penalties = penSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.status === "Confirmed");
  const paidOf = (p) => Math.min(num(p.paidAmount), num(p.amount));

  // ── cards that tie to the other tabs ──
  // Received in period = penalty money that moved in the period: exactly what "Penalties" under Money in adds up.
  const receivedInPeriod = entrySnap.docs
    .map((d) => d.data())
    .filter((e) => lowerS(e.status) === "success" && e.direction === "in" && e.phase === "penalty")
    .reduce((s, e) => s + num(e.amount), 0);
  // Unpaid now = what is still owed on ANY Confirmed penalty, whichever month it was charged.
  const unpaidAll = confirmedSnap.docs.map((d) => d.data())
    .reduce((acc, p) => {
      const owed = Math.max(0, num(p.amount) - Math.min(num(p.paidAmount), num(p.amount)));
      if (owed > 0) { acc.amount += owed; if (p.userID) acc.users.add(p.userID); }
      return acc;
    }, { amount: 0, users: new Set() });

  // ── how each penalty was settled: money received / held deposit / held discount credit ──
  // A deposit offset moves no money and writes no entry row; a discount-credit offset writes an "internal" row. So:
  //   received = penalty money that came in (success "in" rows), credit = internal credit rows, deposit = what is left of paidAmount.
  const entriesByPenalty = await getEntriesForPenaltyIDs(penalties.map((p) => p.penaltyID || p.id));
  const settle = (p) => {
    const rows = entriesByPenalty.get(p.penaltyID || p.id) || [];
    const paid = paidOf(p);
    const inRows = rows.filter((e) => e.direction === "in" && e.phase === "penalty" && lowerS(e.status) === "success");
    const received = Math.min(paid, round2(inRows.reduce((s, e) => s + num(e.amount), 0)));
    const credit = Math.min(Math.max(0, paid - received), round2(rows
      .filter((e) => e.direction === "internal" && e.phase === "discount_applied_penalty" && lowerS(e.status) === "success")
      .reduce((s, e) => s + num(e.amount), 0)));
    const deposit = Math.max(0, round2(paid - received - credit));
    const last = inRows.map((e) => ({ e, d: toDate(e.settledAt) || toDate(e.createdAt) })).sort((a, b) => (b.d?.getTime() || 0) - (a.d?.getTime() || 0))[0] || null;
    return { paid, received, credit, deposit, lastMethod: last ? methodLabel(last.e.method) : null, lastPaidAt: last?.d ? last.d.toISOString() : null, reference: last?.e.referenceNumber || null };
  };

  const collectedByCar = {};
  const pairs = new Map();
  let penaltiesCollected = 0;
  let penaltiesPending = 0;
  let penaltiesCharged = 0;
  let coveredByDeposit = 0;
  let coveredByCredit = 0;
  let receivedOnThese = 0;
  const pendingUsers = new Set();
  const settled = new Map();

  penalties.forEach((p) => {
    const amount = num(p.amount);
    const s = settle(p);
    settled.set(p.penaltyID || p.id, s);
    const pending = Math.max(0, amount - s.paid);
    penaltiesCharged += amount;
    penaltiesCollected += s.paid;
    penaltiesPending += pending;
    coveredByDeposit += s.deposit;
    coveredByCredit += s.credit;
    receivedOnThese += s.received;
    if (pending > 0 && p.userID) pendingUsers.add(p.userID);
    if (p.carID) collectedByCar[p.carID] = (collectedByCar[p.carID] || 0) + s.paid;

    const key = `${p.userID || "?"}|${p.carID || "?"}`;
    const row = pairs.get(key) || { userID: p.userID || null, carID: p.carID || null, count: 0, total: 0, paid: 0 };
    row.count += 1; row.total += amount; row.paid += s.paid;
    pairs.set(key, row);
  });

  // ── maintenance jobs (Completed in the period, plus Scheduled ones dated in it), each tied to its booking when it has one ──
  const jobSnap = await db.collection("maintenance").where("status", "in", ["Completed", "completed", "Scheduled", "scheduled"]).get();
  const jobDocs = jobSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .map((m) => ({ ...m, _date: toDate(m.maintenanceDate) || toDate(m.createdAt) || toDate(m.updatedAt), _done: lowerS(m.status) === "completed" }))
    .filter((m) => m._date && m._date >= start && m._date <= end);
  const jobBookingIDs = uniq(jobDocs.map((m) => m.bookingID));
  const [jobBookings, bookingPenSnaps] = await Promise.all([
    loadBookingsByIDs(jobBookingIDs),
    Promise.all(chunk(jobBookingIDs, 30).map((part) => db.collection("penalties").where("bookingID", "in", part).get())),
  ]);
  const penaltiesByBooking = new Map();   // every Confirmed penalty of the booking, whichever month it was charged
  bookingPenSnaps.forEach((snap) => snap.docs.forEach((d) => {
    const p = { id: d.id, ...d.data() };
    if (p.status !== "Confirmed") return;
    const list = penaltiesByBooking.get(p.bookingID) || [];
    list.push(p);
    penaltiesByBooking.set(p.bookingID, list);
  }));
  const bookingPenEntries = await getEntriesForPenaltyIDs([...penaltiesByBooking.values()].flat().map((p) => p.penaltyID || p.id));

  // Penalty money on a booking pays its repairs oldest first, never more than the repairs cost; the rest is absorbed by the business.
  const jobsSorted = [...jobDocs].sort((a, b) => a._date - b._date);
  const leftOnBooking = new Map();
  [...penaltiesByBooking.entries()].forEach(([bid, list]) => leftOnBooking.set(bid, list.reduce((s, p) => s + paidOf(p), 0)));
  const jobRowsRaw = jobsSorted.map((m) => {
    const amount = num(m.totalCost);
    const bid = m.bookingID || null;
    let covered = 0;
    if (bid && m._done) {
      const left = leftOnBooking.get(bid) || 0;
      covered = round2(Math.min(amount, left));
      leftOnBooking.set(bid, left - covered);
    }
    const linked = bid ? (penaltiesByBooking.get(bid) || []) : [];
    return {
      id: m.id, carID: m.carID || null, bookingID: bid, userID: bid ? (jobBookings[bid]?.userID || null) : null,
      date: m._date.toISOString(), basis: m.basis || "", status: m._done ? "Completed" : "Scheduled",
      services: (m.services || []).map((s) => s.serviceName).filter(Boolean).join(", "),
      amount, covered, absorbed: m._done ? round2(amount - covered) : null,
      penalties: linked.map((p) => {
        const rows = bookingPenEntries.get(p.penaltyID || p.id) || [];
        const inRows = rows.filter((e) => e.direction === "in" && e.phase === "penalty" && lowerS(e.status) === "success");
        const paid = paidOf(p);
        const received = Math.min(paid, round2(inRows.reduce((s, e) => s + num(e.amount), 0)));
        const credit = Math.min(Math.max(0, paid - received), round2(rows.filter((e) => e.direction === "internal" && e.phase === "discount_applied_penalty" && lowerS(e.status) === "success").reduce((s, e) => s + num(e.amount), 0)));
        return { penaltyID: p.penaltyID || p.id, amount: num(p.amount), paid, received, credit, deposit: Math.max(0, round2(paid - received - credit)), pending: Math.max(0, num(p.amount) - paid), createdAt: toDate(p.createdAt)?.toISOString() || null };
      }),
    };
  });

  // ── cars: maintenance per car, "recovered" = penalty money on the SAME BOOKING as each repair ──
  const maintByCar = new Map();
  jobRowsRaw.forEach((j) => {
    const cur = maintByCar.get(j.carID) || { carID: j.carID, total: 0, jobs: 0, recovered: 0, scheduled: 0, scheduledJobs: 0 };
    if (j.status === "Completed") { cur.total += j.amount; cur.jobs += 1; cur.recovered += j.covered; }
    else { cur.scheduled += j.amount; cur.scheduledJobs += 1; }
    maintByCar.set(j.carID, cur);
  });

  // ── names ──
  const pairRows = [...pairs.values()];
  const carIDsAll = uniq([...pairRows.map((r) => r.carID), ...jobRowsRaw.map((j) => j.carID), ...penalties.map((p) => p.carID), ...[...maintByCar.keys()]]);
  const carNames = await resolveVehicleNames(carIDsAll);
  const userIDs = uniq([...pairRows.map((r) => r.userID), ...penalties.map((p) => p.userID), ...jobRowsRaw.map((j) => j.userID)]);
  const userNames = {};
  await Promise.all(userIDs.map(async (id) => { userNames[id] = await resolveUserName(id).catch(() => "Unknown"); }));

  const cars = [...maintByCar.values()]
    .map((c) => ({ carID: c.carID, name: carNames[c.carID] || "Unknown Vehicle", jobs: c.jobs, total: c.total, recovered: round2(c.recovered), absorbed: round2(c.total - c.recovered), scheduled: c.scheduled, scheduledJobs: c.scheduledJobs }))
    .sort((a, b) => (b.total + b.scheduled) - (a.total + a.scheduled));
  const totalMaintenance = cars.reduce((s, c) => s + c.total, 0);
  const scheduledTotal = cars.reduce((s, c) => s + c.scheduled, 0);
  const totalAbsorbed = cars.reduce((s, c) => s + c.absorbed, 0);

  const jobs = jobRowsRaw
    .map((j) => ({ ...j, car: carNames[j.carID] || "Unknown Vehicle", customer: j.userID ? (userNames[j.userID] || "Unknown") : null }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  let rows = pairRows.map((r) => ({
    userID: r.userID,
    carID: r.carID,
    customer: userNames[r.userID] || "Unknown",
    car: carNames[r.carID] || "Unknown Vehicle",
    penalties: r.count,
    total: r.total,
    paid: r.paid,
    pending: Math.max(0, r.total - r.paid),
  }));

  // One row per Confirmed penalty: who, which booking, how much, and how it was settled. The page lists these directly.
  const penaltyRows = penalties.map((p) => {
    const amount = num(p.amount);
    const s = settled.get(p.penaltyID || p.id);
    const pending = Math.max(0, amount - s.paid);
    return {
      penaltyID: p.penaltyID || p.id,
      bookingID: p.bookingID || null,
      maintenanceID: p.maintenanceID || null,
      userID: p.userID || null,
      carID: p.carID || null,
      customer: userNames[p.userID] || "Unknown",
      car: carNames[p.carID] || "Unknown Vehicle",
      createdAt: toDate(p.createdAt)?.toISOString() || null,
      reason: (Array.isArray(p.lineItems) && p.lineItems.length ? p.lineItems.map((li) => li.description).filter(Boolean).join(", ") : "") || p.statusReason || "",
      lineItems: Array.isArray(p.lineItems) ? p.lineItems.map((li) => ({ description: li.description || "", amount: num(li.amount) })) : [],
      amount,
      paid: s.paid,
      received: s.received,
      coveredByDeposit: s.deposit,
      coveredByCredit: s.credit,
      pending,
      paidStatus: pending <= 0 ? "Paid" : s.paid > 0 ? "Partly paid" : "Unpaid",
      lastMethod: s.lastMethod,
      lastPaidAt: s.lastPaidAt,
      reference: s.reference,
    };
  }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0);   // fixed scale for the graph, same on every page

  if (search) rows = rows.filter((r) => r.customer.toLowerCase().includes(search) || r.car.toLowerCase().includes(search));
  rows.sort((a, b) => sort === "unpaid"
    ? (b.pending - a.pending) || (b.total - a.total)
    : (b.total - a.total) || (b.pending - a.pending));

  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(Math.max(parseInt(opts.page, 10) || 1, 1), totalPages);

  return {
    period, label,
    generatedAt: new Date().toISOString(),
    cards: {
      totalMaintenance,
      scheduledMaintenance: scheduledTotal,
      maintenanceAbsorbed: totalAbsorbed,
      penaltiesCharged,                      // Confirmed penalties charged in the period
      penaltiesCollected,                    // paid so far on those (money received + deposit + credit), kept for older screens
      penaltiesReceived: receivedInPeriod,   // penalty money received in the period: the same figure as Penalties under Money in
      penaltiesReceivedOnCharged: receivedOnThese,
      penaltiesCoveredByDeposit: coveredByDeposit,
      penaltiesCoveredByCredit: coveredByCredit,
      penaltiesPending,                      // still owed on the penalties charged in the period
      penaltiesUnpaidAll: unpaidAll.amount,  // still owed on any Confirmed penalty, from any period
      pendingCustomers: pendingUsers.size,
      pendingCustomersAll: unpaidAll.users.size,
    },
    cars,
    jobs,
    penaltyRows,
    customers: {
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
      page, pageSize, totalRows, totalPages, maxTotal, sort,
    },
  };
};

// ── MONEY: Revenue & Expense + Payments & Transactions ──────────────────────

/**
 * One report that feeds BOTH money tabs (they share the same query, so the page fetches it once).
 *
 * MONEY MOVED is read from paymentEntries (one row per movement), dated by settledAt = the day the money moved,
 * not the day the booking was made. Only status "success" rows count.
 *
 *   in         deposit / balance            -> Rentals
 *              penalty                      -> Penalties
 *   out        deposit / balance / penalty  -> Refunds
 *              discount / discount_return   -> Discount returns
 *   deposit returns come from the PAYMENT (depositStatus Settled: depositReturned, dated by depositSettledAt), not
 *              from entries, so a return is never counted twice.
 *   internal   deposit_forfeited            -> money the business kept (informational, nothing moved)
 *
 * The booking amount includes the refundable security deposit, so Rentals is money IN and the deposit comes back OUT
 * as a return. That is why Revenue is money in minus money returned: a deposit still held is not revenue yet, and a
 * penalty covered by the held deposit stays in the result without being paid twice.
 *
 *   Revenue = Rentals + Penalties - Returned - Deposits held back      Net = Revenue - Maintenance (Completed only) - PayMongo fees
 *   That formula is read two ways: cards / series / cars by the day the money moved (Payments & Transactions), and
 *   revenueBasis by the day the booking is FINALIZED (Revenue & Expense): only completed (deposit settled), cancelled and stolen
 *   bookings count; money for an upcoming / ongoing booking is not revenue yet and is not shown anywhere as "expected".
 *   Deposits held back = security deposits that came in minus those settled in the period: a held deposit is not revenue yet.
 *
 * PAYMENT RECORDS are the payments CREATED in the period, labelled with the Payments page's own derivePaymentStage().
 * Deposits held is a snapshot of right now (every payment whose deposit is still Held), not tied to the period.
 */
export const generateMoneyReport = async (period, selection = {}) => {
  const { start, end, label } = getRange(period, selection);
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  const [entrySnap, settledSnap, heldSnap, paySnap, refundSnap, maintenance, pendingOutSnap, creditSnap] = await Promise.all([
    db.collection(ENTRY_COLLECTION).where("settledAt", ">=", start).where("settledAt", "<=", end).get(),
    db.collection("payments").where("depositSettledAt", ">=", start).where("depositSettledAt", "<=", end).get(),
    db.collection("payments").where("depositStatus", "==", "Held").get(),
    db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt", "asc").get(),
    db.collection("refundRequests").where("status", "in", ["Pending", "Approved"]).get(),
    loadMaintenanceExpenses(start, end),
    db.collection(ENTRY_COLLECTION).where("direction", "==", "out").where("status", "==", "pending").get(),
    db.collection("payments").where("discountCredit", ">", 0).get(),   // discount credit still held for the customer (see discountLedger.js)
  ]);

  const entries = entrySnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => lower(e.status) === "success");
  const paymentDocs = paySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const settledDocs = settledSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => lower(p.depositStatus) === "settled");
  const openRefundPaymentIDs = new Set(refundSnap.docs.map((d) => d.data().paymentID).filter(Boolean));
  // Refunds staff APPROVED that have not been paid out yet (some are scheduled to send at the next midnight). They are
  // money we are committed to return: shown in Money out as "expected", as of today, whatever period is selected.
  // Pending requests are not decided yet, so they are left out. Once paid they become success rows of paymentEntries.
  const approvedRefunds = refundSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => lower(r.status) === "approved")
    .map((r) => ({ ...r, expectedAmount: Number(r.toRefundAmount ?? r.amount) || 0 }))
    .filter((r) => r.expectedAmount > 0);

  // Deposit and discount returns sent online wait as "pending" rows until PayMongo confirms them. They are money we are
  // committed to return, so they count as AWAITING (not as already paid out). Pending refunds are not read here: those
  // come from approved refundRequests (below), and reading both would count them twice.
  const pendingPayouts = pendingOutSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((e) => (e.phase === "deposit_return" || e.phase === "discount_return") && num(e.amount) > 0);
  const pendingDepositPaymentIDs = new Set(pendingPayouts.filter((e) => e.phase === "deposit_return").map((e) => e.paymentID).filter(Boolean));

  // ── one flat list of everything that moved ──
  const flows = [];   // { kind, date, bookingID, userID, amount, source, method }
  let forfeited = 0;
  entries.forEach((e) => {
    const date = toDate(e.settledAt);
    const amount = num(e.amount);
    if (!date || amount <= 0) return;
    const base = { date, entryID: e.id || null, reference: e.referenceNumber || null, paymentID: e.paymentID || null, phase: e.phase || null, bookingID: e.bookingID || null, userID: e.userID || null, amount, method: e.method || null,
      source: e.source === "in_person" || (!e.source && lower(e.method) === "cash") ? "in_person" : "online" };
    if (e.direction === "in") {
      if (e.phase === "penalty") flows.push({ ...base, kind: "penalty" });
      else if (e.phase === "deposit" || e.phase === "balance") flows.push({ ...base, kind: "rental" });
    } else if (e.direction === "out") {
      if (e.phase === "deposit_return") return;   // counted once, from the payment below
      flows.push({ ...base, kind: e.phase === "discount" || e.phase === "discount_return" ? "discount_return" : "refund" });
    } else if (e.phase === "deposit_forfeited") {
      forfeited += amount;
    }
  });

  // How each deposit was actually handed back (online through PayMongo, or in person): read from its deposit_return row.
  const settledEntries = await getEntriesForPaymentIDs(settledDocs.map((p) => p.paymentID || p.originalId || p.id));
  const returnRowOf = (p) => {
    const rows = (settledEntries.get(p.paymentID || p.originalId || p.id) || []).filter((e) => e.direction === "out" && e.phase === "deposit_return" && lower(e.status) !== "failed");
    return rows.sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0))[0] || null;
  };
  const sourceOf = (e) => (e && (e.source === "in_person" || (!e.source && lower(e.method) === "cash")) ? "in_person" : e ? "online" : "in_person");   // no row at all = handed back in store

  let depositUsed = 0;   // held deposits used to cover penalties: kept, nothing paid again
  settledDocs.forEach((p) => {
    const view = getDepositView(p);
    const date = toDate(p.depositSettledAt);
    if (!view || !date) return;
    depositUsed += num(view.deducted);
    const payKey = p.paymentID || p.originalId || p.id;
    if (num(view.returnedAmount) > 0 && !pendingDepositPaymentIDs.has(payKey)) {   // still pending at PayMongo = awaiting, not paid out
      const row = returnRowOf(p);
      flows.push({ kind: "deposit_return", date, paymentID: p.paymentID || p.originalId || p.id, bookingID: p.bookingID || null, userID: p.userID || null, amount: num(view.returnedAmount), source: sourceOf(row), method: row?.method || null });
    }
  });

  let depositsHeld = 0;
  heldSnap.docs.forEach((d) => { const v = getDepositView(d.data()); if (v && v.status === "Held") depositsHeld += num(v.amount); });

  // ── lookups ──
  const bookingMap = await loadBookingsByIDs([...flows.map((f) => f.bookingID), ...paymentDocs.map((p) => p.bookingID), ...approvedRefunds.map((r) => r.bookingID), ...pendingPayouts.map((e) => e.bookingID)]);
  const entriesByPayment = await getEntriesForPaymentIDs(paymentDocs.map((p) => p.paymentID || p.originalId || p.id));
  const views = buildPaymentViews(paymentDocs, entriesByPayment, bookingMap);

  // Money that COULD still go back (nothing has moved yet): every deposit and every discount credit still held (upcoming,
  // ongoing or completed bookings), plus the refunds already scheduled / approved. A payment already counted as a scheduled
  // refund is not counted a second time.
  const payKeyOf = (p) => p.paymentID || p.originalId || p.id;
  const refundingPaymentIDs = new Set(approvedRefunds.map((r) => r.paymentID).filter(Boolean));   // already counted as a scheduled refund
  const heldPayments = heldSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const creditPayments = creditSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => num(p.discountCredit) > 0);
  Object.assign(bookingMap, await loadBookingsByIDs([...heldPayments, ...creditPayments, ...settledSnap.docs.map((d) => d.data())].map((p) => p.bookingID).filter(Boolean)));
  const isDue = (p) => !refundingPaymentIDs.has(payKeyOf(p));
  const heldDue = heldPayments.filter((p) => { const v = getDepositView(p); return v && v.status === "Held" && num(v.amount) > 0 && isDue(p); });
  const creditDue = creditPayments.filter(isDue);
  const userOfPay = (p) => p.userID || bookingMap[p.bookingID]?.userID || null;

  flows.forEach((f) => {
    const b = bookingMap[f.bookingID];
    f.carID = b?.carID || null;
    if (!f.userID) f.userID = b?.userID || null;
  });

  // ── REVENUE BASIS: money counts as revenue on the day the BOOKING ENDED (completed / cancelled / stolen) ──
  // The Payments & Transactions tab stays by the day the money moved, because that is what matches PayMongo.
  // Revenue & Expense uses its own list, `revFlows`, built from the same entries with a different date. Only bookings that
  // are over count (see finalizeBookings): completed, cancelled or stolen. Everything else (to pay, upcoming,
  // ongoing) is simply not read: there is no "expected" revenue or expense.
  //   - completed / stolen: all of a booking's money lands on its finalization day, or on the day it was paid if that is later
  //     (a penalty paid after the booking was finalized counts on the day it was paid)
  //   - cancelled: everything (what came in, what went back) counts on the cancellation day, so only what you keep
  //     (a forfeited deposit, a gateway fee kept) stays and a refunded amount never becomes revenue
  // Example: paid Nov 1, trip completed Nov 7  ->  the revenue is recorded on Nov 7, the same day as its maintenance.
  //          The deposit is left out while held; when it is settled later (returned, used on a penalty, forfeited), the kept
  //          part is added on that day.
  const recDateOf = (b, date) => {
    if (!b || !b.finalizedAt) return null;   // no booking / not finalized yet: not revenue
    if (b.status === "cancelled") return b.finalizedAt;
    return b.finalizedAt > date ? b.finalizedAt : date;
  };
  const keysOfBooking = (doc) => uniq([doc.id, doc.data().bookingID]);
  const [completedSnap, touchedSnap] = await Promise.all([
    db.collection("bookings").where("completedAt", ">=", start).where("completedAt", "<=", end).get(),
    db.collection("bookings").where("updatedAt", ">=", start).where("updatedAt", "<=", end).get(),   // cancelled / stolen bookings are found by their last update
  ]);
  const endedInPeriod = touchedSnap.docs.filter((d) => ["cancelled", "stolen"].includes(normalizeBookingStatus(d.data().status)));
  // candidates: bookings completed / cancelled / stolen in the period, plus those whose deposit was settled in the period
  const relKeys = uniq([...completedSnap.docs, ...endedInPeriod].flatMap(keysOfBooking).concat(settledDocs.map((p) => p.bookingID).filter(Boolean)));
  const byBookingKeys = async (collectionName, keys) => {
    const out = [];
    for (const part of chunk(keys, 30)) {
      const snap = await db.collection(collectionName).where("bookingID", "in", part).get();
      snap.docs.forEach((d) => out.push({ id: d.id, ...d.data() }));
    }
    return out;
  };
  const [relEntries, relPayments] = await Promise.all([
    byBookingKeys(ENTRY_COLLECTION, relKeys),
    loadPaymentsByBookingKeys(relKeys),
  ]);
  const allEntries = new Map();
  [...entries, ...relEntries].forEach((e) => { if (lower(e.status) === "success") allEntries.set(e.id, e); });
  Object.assign(bookingMap, await loadBookingsByIDs([
    ...[...allEntries.values()].map((e) => e.bookingID), ...relPayments.map((p) => p.bookingID),
    ...completedSnap.docs.map((d) => d.id), ...endedInPeriod.map((d) => d.id),
  ].filter(Boolean)));
  finalizeBookings(bookingMap);

  const revFlows = [];
  allEntries.forEach((e) => {
    const settled = toDate(e.settledAt);
    const amount = num(e.amount);
    if (!settled || amount <= 0) return;
    const b = bookingMap[e.bookingID] || null;
    let kind = null;
    if (e.direction === "in") {
      if (e.phase === "penalty") kind = "penalty";
      else if (e.phase === "deposit" || e.phase === "balance") kind = "rental";
    } else if (e.direction === "out") {
      if (e.phase === "deposit_return") return;   // counted once, from the payment below
      kind = e.phase === "discount" || e.phase === "discount_return" ? "discount_return" : "refund";
    }
    if (!kind) return;
    const date = recDateOf(b, settled);
    if (!date || date < start || date > end) return;
    revFlows.push({ kind, date, paymentID: e.paymentID || null, phase: e.phase || null, bookingID: e.bookingID || null, userID: e.userID || b?.userID || null, carID: b?.carID || null, amount });
  });
  // A cancelled booking's refund that is APPROVED but not paid out yet (scheduled for the next midnight, or waiting for the
  // customer to collect it in store) is money we are committed to return: the deposit already left "Held" when it was approved,
  // so without this the rental money would show as revenue until the refund is really sent. It is counted as returned on the
  // cancellation day; what has already been paid out (success rows) is read above, so only the unpaid rest is added here.
  // It is kept apart from Returned (kind "pending_refund") and shown in the "To return" column together with the held deposits.
  approvedRefunds.forEach((r) => {
    const b = bookingMap[r.bookingID] || null;
    if (!b || b.status !== "cancelled" || !b.finalizedAt || b.finalizedAt < start || b.finalizedAt > end) return;
    const reqID = r.refundRequestID || r.id;
    const alreadyOut = [...allEntries.values()]
      .filter((e) => e.direction === "out" && e.phase !== "deposit_return" && (e.refundReqID === reqID || e.refundRequestID === reqID))
      .reduce((t, e) => t + num(e.amount), 0);
    const rest = r.expectedAmount - alreadyOut;
    if (rest > 0) revFlows.push({ kind: "pending_refund", date: b.finalizedAt, paymentID: r.paymentID || null, phase: "refund", bookingID: r.bookingID || null, userID: r.userID || b.userID || null, carID: b.carID || null, amount: rest });
  });
  const revPayByID = await loadPaymentsByIDs(revFlows.filter((f) => f.kind === "rental").map((f) => f.paymentID));
  revFlows.forEach((f) => { if (f.kind === "rental") f.deposit = splitRentalEntry(f, revPayByID[f.paymentID] || null).deposit; });

  // deposits settled (kept, returned, used or refunded): the same payments as above, plus the payments of bookings finalized in the period
  const revSettled = [];
  const settledCandidates = new Map();
  settledDocs.forEach((p) => settledCandidates.set(p.id, p));
  relPayments.filter((p) => lower(p.depositStatus) === "settled").forEach((p) => settledCandidates.set(p.id, p));
  settledCandidates.forEach((p) => {
    const v = getDepositView(p);
    const settledAt = toDate(p.depositSettledAt);
    if (!v || v.status === "Held" || !settledAt) return;
    const key = p.paymentID || p.originalId || p.id;
    if (pendingDepositPaymentIDs.has(key)) return;   // still pending at PayMongo = treated as held
    const b = bookingMap[p.bookingID] || null;
    const date = recDateOf(b, settledAt);
    if (!date || date < start || date > end) return;
    const base = { date, paymentID: key, bookingID: p.bookingID || null, userID: p.userID || b?.userID || null, carID: b?.carID || null };
    if (num(v.amount) > 0) revSettled.push({ ...base, amount: num(v.amount) });
    if (num(v.returnedAmount) > 0) revFlows.push({ ...base, kind: "deposit_return", amount: num(v.returnedAmount) });
  });

  const carIDs = uniq([...flows.map((f) => f.carID), ...revFlows.map((f) => f.carID), ...revSettled.map((x) => x.carID), ...maintenance.map((m) => m.carID), ...views.map((v) => v.carID)]);
  approvedRefunds.forEach((r) => { r.userID = r.userID || bookingMap[r.bookingID]?.userID || null; });
  const userIDs = uniq([...flows.map((f) => f.userID), ...revFlows.map((f) => f.userID), ...revSettled.map((x) => x.userID), ...views.map((v) => v.userID || v.p.userID), ...approvedRefunds.map((r) => r.userID), ...pendingPayouts.map((e) => e.userID), ...heldDue.map(userOfPay), ...creditDue.map(userOfPay)]);
  const [carNames, userNames] = await Promise.all([resolveVehicleNames(carIDs), resolveUserNames(userIDs)]);
  const customerOf = (id) => (id && userNames[id] && userNames[id] !== "—" ? userNames[id] : "Unknown");

  // ── Money in by what it was FOR (rental / service fee / gateway fee / deposit / penalties) ──
  const payByID = await loadPaymentsByIDs(flows.filter((f) => f.kind === "rental").map((f) => f.paymentID));
  // ── the refundable security deposit is not revenue while it is held ──
  // Each rental payment carries its deposit part; a deposit only becomes revenue for the part you KEEP (forfeited, or used on a
  // penalty). So the deposit is left out when it comes in, and added back when it is settled (returned, refunded with a
  // cancellation, forfeited or used): a returned deposit then nets to zero, a kept one stays. A return still pending at
  // PayMongo is treated as still held until it is confirmed, the same as Returned does.
  flows.forEach((f) => { if (f.kind === "rental") f.deposit = splitRentalEntry(f, payByID[f.paymentID] || null).deposit; });
  const depositSettled = [];
  settledSnap.docs.forEach((d) => {
    const p = d.data();
    const v = getDepositView(p);
    const date = toDate(p.depositSettledAt);
    if (!v || v.status === "Held" || !date || !(num(v.amount) > 0)) return;
    if (pendingDepositPaymentIDs.has(p.paymentID || p.originalId || d.id)) return;
    depositSettled.push({ date, amount: num(v.amount), carID: bookingMap[p.bookingID]?.carID || null, bookingID: p.bookingID || null, userID: p.userID || null });
  });
  const PART_NAMES = { rental: "Rental & other fees", service: "Service fee", gateway: "Gateway fee", deposit: "Deposit (refundable)", penalty: "Penalties" };
  const partMap = new Map();
  const addPart = (key, f, amt) => {
    if (!(amt > 0)) return;
    const row = partMap.get(key) || { id: key, name: PART_NAMES[key], count: 0, online: 0, inPerson: 0, total: 0, subs: new Map() };
    const mlabel = methodLabel(f.method) === "—" ? "Other" : methodLabel(f.method);
    const sub = row.subs.get(mlabel) || { id: `${key}:${mlabel}`, name: mlabel, count: 0, online: 0, inPerson: 0, total: 0 };
    [row, sub].forEach((t) => { t.count += 1; t.total += amt; if (f.source === "online") t.online += amt; else t.inPerson += amt; });
    row.subs.set(mlabel, sub);
    partMap.set(key, row);
  };
  flows.forEach((f) => {
    if (f.kind === "penalty") addPart("penalty", f, f.amount);
    else if (f.kind === "rental") {
      const s = splitRentalEntry(f, payByID[f.paymentID] || null);
      addPart("rental", f, s.rental); addPart("service", f, s.service); addPart("gateway", f, s.gateway); addPart("deposit", f, s.deposit);
    }
  });
  const inParts = ["rental", "service", "gateway", "deposit", "penalty"].filter((k) => partMap.has(k)).map((k) => {
    const { subs, ...row } = partMap.get(k);
    return { ...row, children: [...subs.values()].sort((a, b) => b.total - a.total) };
  });
  const gatewayReceived = partMap.has("gateway") ? partMap.get("gateway").total : 0;

  // ── fees PayMongo kept on the online charges that came in (transactionFee on the entry) ──
  const PHASE_NAMES = { deposit: "Fee on deposit payments", balance: "Fee on balance payments", penalty: "Fee on penalty payments" };
  const feeMap = new Map();
  let feeUnrecorded = 0, feeOnBookings = 0;
  const feeItems = [];   // { date, fee, bookingID, carID }: the same fees, kept one by one so Net can subtract them per day and per car
  entries.forEach((e) => {
    if (e.direction !== "in" || !PHASE_NAMES[e.phase]) return;
    const online = !(e.source === "in_person" || (!e.source && lower(e.method) === "cash"));
    if (!online) return;
    if (e.transactionFee === null || e.transactionFee === undefined) { feeUnrecorded += 1; return; }
    const fee = num(e.transactionFee);
    feeItems.push({ date: toDate(e.settledAt), fee, bookingID: e.bookingID || null, carID: bookingMap[e.bookingID]?.carID || null });
    const label = methodLabel(e.method) === "—" ? "Other" : methodLabel(e.method);
    const row = feeMap.get(label) || { id: label, name: label, count: 0, fee: 0, total: 0, subs: new Map() };
    const sub = row.subs.get(e.phase) || { id: `${label}:${e.phase}`, name: PHASE_NAMES[e.phase], count: 0, fee: 0, total: 0 };
    [row, sub].forEach((t) => { t.count += 1; t.fee += fee; t.total += fee; });
    row.subs.set(e.phase, sub);
    feeMap.set(label, row);
    if (e.phase !== "penalty") feeOnBookings += fee;
  });
  const feeRows = [...feeMap.values()].map(({ subs, ...row }) => ({ ...row, children: [...subs.values()].sort((a, b) => b.total - a.total) })).sort((a, b) => b.total - a.total);
  const fees = { rows: feeRows, total: feeRows.reduce((s, r) => s + r.total, 0), unrecorded: feeUnrecorded, gatewayReceived, bookingFees: feeOnBookings };
  // The same online fees, dated like the revenue they belong to (the booking's finalization day), so Net compares matching things.
  // A fee on a booking that is not finalized yet is left out until it is.
  const revFeeItems = [];
  let revFeeUnrecorded = 0;
  allEntries.forEach((e) => {
    if (e.direction !== "in" || !PHASE_NAMES[e.phase]) return;
    if (e.source === "in_person" || (!e.source && lower(e.method) === "cash")) return;
    const settled = toDate(e.settledAt);
    if (!settled) return;
    const date = recDateOf(bookingMap[e.bookingID] || null, settled);
    if (!date || date < start || date > end) return;
    if (e.transactionFee === null || e.transactionFee === undefined) { revFeeUnrecorded += 1; return; }
    revFeeItems.push({ date, fee: num(e.transactionFee), bookingID: e.bookingID || null, carID: bookingMap[e.bookingID]?.carID || null });
  });
  const revFeesTotal = revFeeItems.reduce((t, x) => t + x.fee, 0);

  // ── totals ──
  const sum = (kind) => flows.filter((f) => f.kind === kind).reduce((s, f) => s + f.amount, 0);
  const rentals = sum("rental"), penalties = sum("penalty");
  const refunds = sum("refund"), depositReturns = sum("deposit_return"), discountReturns = sum("discount_return");
  const returned = refunds + depositReturns + discountReturns;
  const depositIn = flows.reduce((sum, f) => sum + (f.kind === "rental" ? (f.deposit || 0) : 0), 0);
  const depositOut = depositSettled.reduce((sum, x) => sum + x.amount, 0);
  const depositHeldChange = depositIn - depositOut;   // deposits that came in and are still held (negative: more was settled than came in)
  const revenue = rentals + penalties - returned - depositHeldChange;
  const maintenanceTotal = maintenance.reduce((s, m) => s + m.amount, 0);
  const signed = (f) => (f.kind === "rental" ? f.amount - (f.deposit || 0) : f.kind === "penalty" ? f.amount : -f.amount);   // a deposit is not revenue while held

  // ── time series: days (week / month / day) or months (year), every bucket listed so the chart has no gaps ──
  const g = period === "yearly" ? "month" : "day";
  const buildSeries = (flowList, settledList, feeList) => {
    const keyOf = (d) => (g === "month" ? `${d.getFullYear()}-${d.getMonth()}` : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    const buckets = new Map();
    for (let s = bucketStart(g, start); s <= end; s = g === "month" ? new Date(s.getFullYear(), s.getMonth() + 1, 1) : new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)) {
      buckets.set(keyOf(s), {
        key: keyOf(s), label: bucketLabel(g, s),
        short: g === "month" ? monthShort(s.getMonth()) : period === "daily" ? `${monthShort(s.getMonth())} ${s.getDate()}` : String(s.getDate()),
        rentals: 0, penalties: 0, refunds: 0, depositReturns: 0, discountReturns: 0, returned: 0, deposits: 0, maintenance: 0, fees: 0,
      });
    }
    flowList.forEach((f) => {
      const b = buckets.get(keyOf(f.date));
      if (!b) return;
      if (f.kind === "rental") { b.rentals += f.amount; b.deposits += f.deposit || 0; }
      else if (f.kind === "penalty") b.penalties += f.amount;
      else if (f.kind === "pending_refund") b.deposits += f.amount;   // approved but not paid out yet: "To return", with the held deposits
      else {
        // money that went back: kept apart so the report can show each one, and `returned` stays their total (Net is unchanged)
        if (f.kind === "refund") b.refunds += f.amount;
        else if (f.kind === "deposit_return") b.depositReturns += f.amount;
        else if (f.kind === "discount_return") b.discountReturns += f.amount;
        b.returned += f.amount;
      }
    });
    settledList.forEach((x) => { const b = buckets.get(keyOf(x.date)); if (b) b.deposits -= x.amount; });   // `deposits` = held deposits that came in minus those settled that day
    maintenance.forEach((m) => { const b = buckets.get(keyOf(new Date(m.date))); if (b) b.maintenance += m.amount; });
    feeList.forEach((x) => { const b = x.date && buckets.get(keyOf(x.date)); if (b) b.fees += x.fee; });   // PayMongo kept this on the online payments received that day
    return [...buckets.values()].map((b) => ({ ...b, revenue: b.rentals + b.penalties - b.returned - b.deposits, expenses: b.maintenance + b.fees, net: b.rentals + b.penalties - b.returned - b.deposits - b.maintenance - b.fees }));
  };
  const series = buildSeries(flows, depositSettled, feeItems);
  const revSeries = buildSeries(revFlows, revSettled, revFeeItems);

  // ── per car: what it brought in (net of what went back) against what maintenance cost ──
  const buildCars = (flowList, settledList, feeList) => {
    const carMap = new Map();
    const carRow = (carID) => {
      const id = carID || "unknown";
      if (!carMap.has(id)) carMap.set(id, { id, carID: carID || null, ...blankParts(), revenue: 0, maintenance: 0, fees: 0, bookings: new Map(), jobs: [] });
      return carMap.get(id);
    };
    // The parts a revenue figure is made of, the same split the time series uses: Revenue = Rentals + Penalties - Returned - Deposit held back.
    // Without these the vehicle table and its "View" window had Revenue but empty Rentals / Penalties / Returned / Deposit held back columns.
    function blankParts() { return { rentals: 0, penalties: 0, returned: 0, depositsHeld: 0 }; }
    const addFlow = (t, f) => {
      if (f.kind === "rental") { t.rentals += f.amount; t.depositsHeld += f.deposit || 0; }
      else if (f.kind === "penalty") t.penalties += f.amount;
      else if (f.kind === "pending_refund") t.depositsHeld += f.amount;   // approved, not paid out yet: "To return", with the held deposits
      else t.returned += f.amount;
    };
    flowList.forEach((f) => {
      const row = carRow(f.carID);
      row.revenue += signed(f);
      addFlow(row, f);
      const bid = f.bookingID || "unknown";
      const cur = row.bookings.get(bid) || { bookingID: f.bookingID, userID: f.userID, ...blankParts(), net: 0, fees: 0 };
      cur.net += signed(f);
      addFlow(cur, f);
      row.bookings.set(bid, cur);
    });
    settledList.forEach((x) => {   // a settled deposit comes back into the car's revenue (a returned one cancels what was left out)
      const row = carRow(x.carID);
      row.revenue += x.amount;
      row.depositsHeld -= x.amount;
      const bid = x.bookingID || "unknown";
      const cur = row.bookings.get(bid) || { bookingID: x.bookingID, userID: x.userID, ...blankParts(), net: 0, fees: 0 };
      cur.net += x.amount;
      cur.depositsHeld -= x.amount;
      row.bookings.set(bid, cur);
    });
    feeList.forEach((x) => {
      const row = carRow(x.carID);
      row.fees += x.fee;
      const bid = x.bookingID || "unknown";
      const cur = row.bookings.get(bid) || { bookingID: x.bookingID, userID: null, ...blankParts(), net: 0, fees: 0 };
      cur.fees += x.fee;
      row.bookings.set(bid, cur);
    });
    maintenance.forEach((m) => {
      const row = carRow(m.carID);
      row.maintenance += m.amount;
      row.jobs.push(m);
    });
    return [...carMap.values()].map((r) => {
      const children = [
        ...[...r.bookings.values()].sort((a, b) => b.net - a.net).map((b) => ({
          id: `b:${b.bookingID}`, name: `${b.bookingID || "Booking"} · ${customerOf(b.userID)}`,
          rentals: b.rentals, penalties: b.penalties, returned: b.returned, depositsHeld: b.depositsHeld,
          revenue: b.net, maintenance: 0, fees: b.fees || 0, net: b.net - (b.fees || 0),
        })),
        ...r.jobs.sort((a, b) => b.amount - a.amount).map((m) => ({
          id: `m:${m.id}`, name: `Maintenance · ${m.services || m.basis || "Service"}`, rentals: 0, penalties: 0, returned: 0, depositsHeld: 0, revenue: 0, maintenance: m.amount, fees: 0, net: -m.amount,
        })),
      ];
      return {
        id: r.id, name: r.carID ? (carNames[r.carID] || "Unknown Vehicle") : "Unknown Vehicle",
        rentals: r.rentals, penalties: r.penalties, returned: r.returned, depositsHeld: r.depositsHeld,
        revenue: r.revenue, maintenance: r.maintenance, fees: r.fees, net: r.revenue - r.maintenance - r.fees, bookings: r.bookings.size, children,
      };
    });
  };
  const cars = buildCars(flows, depositSettled, feeItems);
  const revCars = buildCars(revFlows, revSettled, revFeeItems);

  // ── money in by method (opens into online / in person), money out by type ──
  const methodMap = new Map();
  const PARTS = ["rental", "service", "gateway", "deposit"];   // what a rental/deposit/balance entry is made of (see splitRentalEntry)
  const blankParts = () => ({ rentals: 0, rental: 0, service: 0, gateway: 0, deposit: 0, penalties: 0, online: 0, inPerson: 0 });
  flows.filter((f) => f.kind === "rental" || f.kind === "penalty").forEach((f) => {
    const label = methodLabel(f.method) === "—" ? "Other" : methodLabel(f.method);
    const m = methodMap.get(label) || { id: label, name: label, count: 0, ...blankParts(), total: 0, subs: new Map(), transactions: [] };
    const sub = m.subs.get(f.source) || { id: `${label}:${f.source}`, name: f.source === "online" ? "Online (PayMongo)" : "In person", count: 0, ...blankParts(), total: 0 };
    const split = f.kind === "rental" ? splitRentalEntry(f, payByID[f.paymentID] || null) : null;
    [m, sub].forEach((t) => {
      t.count += 1; t.total += f.amount;
      if (f.source === "online") t.online += f.amount; else t.inPerson += f.amount;   // the thin second bar: where it was received
      if (f.kind === "rental") { t.rentals += f.amount; PARTS.forEach((k) => { t[k] += split[k]; }); }   // rentals = the sum of the four parts
      else t.penalties += f.amount;
    });
    m.subs.set(f.source, sub);
    // One row per payment received: the same entries the totals above are made of, so a View window always adds up to its row.
    m.transactions.push({
      id: f.entryID || `${label}:${m.transactions.length}`, bookingID: f.bookingID || null, customer: customerOf(f.userID), date: f.date.toISOString(), method: label,
      type: f.kind === "penalty" ? "Penalty payment" : f.phase === "deposit" ? "Deposit paid" : "Balance paid",
      channel: f.source === "online" ? "Online" : "In person", status: "Done", amount: f.amount, reference: f.reference || null,
    });
    methodMap.set(label, m);
  });
  const methodsReceived = [...methodMap.values()].map(({ subs, transactions, ...m }) => ({ ...m, children: [...subs.values()].sort((a, b) => b.total - a.total), transactions: transactions.sort((a, b) => new Date(b.date) - new Date(a.date)) }));

  // ── money out, laid out like Money in: one row per method; its bar is split by the reason the money left (refund,
  //    deposit return, discount return) and the same money is also split by online / in person. Only money handed back to
  //    customers is here: PayMongo's fees are a cost, so they stay out (see `fees`). ──
  // Online refunds, deposit returns and discount returns are saved with no method (PayMongo sends the money back to the
  // original payment method). A payment is always paid with ONE method (a part-payment uses the same one), so the method
  // is simply the one its charges were paid with.
  const needMethod = flows.filter((f) => (f.kind === "refund" || f.kind === "deposit_return" || f.kind === "discount_return") && !f.method && f.source === "online" && f.paymentID);
  if (needMethod.length) {
    const paidEntries = await getEntriesForPaymentIDs(uniq(needMethod.map((f) => f.paymentID)));
    const paidWith = (paymentID) => (paidEntries.get(paymentID) || [])
      .find((e) => e.direction === "in" && lower(e.status) === "success" && (e.phase === "deposit" || e.phase === "balance") && e.method && lower(e.method) !== "cash")?.method || null;
    needMethod.forEach((f) => { f.method = paidWith(f.paymentID); });
  }

  // ── money that could still go back, by the method it was paid with (online refunds and returns go back to it) ──
  const pendIDs = uniq([...approvedRefunds.map((r) => r.paymentID), ...pendingPayouts.map((e) => e.paymentID), ...heldDue.map(payKeyOf), ...creditDue.map(payKeyOf)].filter(Boolean));
  const pendEntries = pendIDs.length ? await getEntriesForPaymentIDs(pendIDs) : new Map();
  const pendMethod = (paymentID, fallback) => {
    const hit = (pendEntries.get(paymentID) || []).find((e) => e.direction === "in" && lower(e.status) === "success" && (e.phase === "deposit" || e.phase === "balance") && e.method);
    const m = methodLabel(hit?.method || fallback);
    return m === "—" ? "Other" : m;
  };
  const fmtDay = (d) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });
  const pending = [
    ...approvedRefunds.map((r) => {
      const sendAfter = r.scheduled ? toDate(r.sendAfter) : null;
      return { kind: "refund", bookingID: r.bookingID || null, userID: r.userID, amount: r.expectedAmount, method: pendMethod(r.paymentID, null),
        note: sendAfter ? `Refund · scheduled, sends after ${fmtDay(sendAfter)}` : "Refund · approved, being paid out" };
    }),
    ...pendingPayouts.map((e) => ({
      kind: e.phase === "deposit_return" ? "deposit" : "discount", bookingID: e.bookingID || null, userID: e.userID || bookingMap[e.bookingID]?.userID || null, amount: num(e.amount), method: pendMethod(e.paymentID, e.method),
      note: `${e.phase === "deposit_return" ? "Deposit return" : "Discount return"} · sent to PayMongo, waiting for confirmation`,
    })),
    ...heldDue.map((p) => ({ kind: "deposit", bookingID: p.bookingID || null, userID: userOfPay(p), amount: num(getDepositView(p).amount), method: pendMethod(payKeyOf(p), p.paymentMethod),
      note: `Deposit held · ${bookingMap[p.bookingID]?.status ? `booking ${bookingMap[p.bookingID].status}, ` : ""}not returned yet (up to this amount: a penalty or damage can reduce it)` })),
    ...creditDue.map((p) => ({ kind: "discount", bookingID: p.bookingID || null, userID: userOfPay(p), amount: num(p.discountCredit), method: pendMethod(payKeyOf(p), p.paymentMethod),
      note: `Discount held · ${bookingMap[p.bookingID]?.status ? `booking ${bookingMap[p.bookingID].status}, ` : ""}goes back with the deposit` })),
  ].filter((w) => w.amount > 0).sort((x, y) => y.amount - x.amount);
  const PEND_KEYS = { refund: "pendRefund", deposit: "pendDeposit", discount: "pendDiscount" };
  const PEND_NAMES = { refund: "Scheduled return", deposit: "Deposit held", discount: "Discount held" };

  const OUT_KEYS = { refund: "refund", deposit_return: "depositReturn", discount_return: "discountReturn" };
  const OUT_NAMES = { refund: "Refund", deposit_return: "Deposit return", discount_return: "Discount return" };
  const outMap = new Map();
  const outRow = (label) => {
    if (!outMap.has(label)) outMap.set(label, { id: label, name: label, count: 0, refund: 0, depositReturn: 0, discountReturn: 0, pendRefund: 0, pendDeposit: 0, pendDiscount: 0, online: 0, inPerson: 0, total: 0, expected: 0, children: [] });
    return outMap.get(label);
  };
  pending.forEach((w, i) => {
    const row = outRow(w.method);
    row[PEND_KEYS[w.kind]] += w.amount; row.expected += w.amount;
    row.children.push({
      id: `${w.method}:pending:${i}`, name: `${w.bookingID || "—"} · ${customerOf(w.userID)}`, date: null, method: w.method, kindLabel: PEND_NAMES[w.kind],
      [PEND_KEYS[w.kind]]: w.amount, online: 0, inPerson: 0, total: 0, expected: w.amount, barTotal: w.amount, pending: true, note: w.note,
      bookingID: w.bookingID || null, customer: customerOf(w.userID), status: "Pending", reference: null,
    });
  });
  flows.filter((f) => OUT_KEYS[f.kind]).sort((x, y) => y.date - x.date).forEach((f) => {
    const m = methodLabel(f.method);
    const label = m !== "—" ? m : f.source === "in_person" ? "Cash" : "Other";
    const row = outRow(label);
    row.count += 1; row[OUT_KEYS[f.kind]] += f.amount; row.total += f.amount;
    if (f.source === "online") row.online += f.amount; else row.inPerson += f.amount;
    row.children.push({
      id: `${label}:${f.kind}:${row.children.length}`, name: `${f.bookingID || "—"} · ${customerOf(f.userID)}`, date: f.date.toISOString(), method: label, kindLabel: OUT_NAMES[f.kind],
      [OUT_KEYS[f.kind]]: f.amount, online: f.source === "online" ? f.amount : 0, inPerson: f.source === "online" ? 0 : f.amount, total: f.amount, expected: 0,
      bookingID: f.bookingID || null, customer: customerOf(f.userID), status: "Done", reference: f.reference || null,
    });
  });
  const outflows = [...outMap.values()].filter((r) => r.total > 0 || r.expected > 0).map((r) => ({ ...r, barTotal: r.total + r.expected })).sort((a, b) => b.barTotal - a.barTotal);

  // What could still go back, for the Possible to return list and card. None of it has moved, so it is not in Money out, Revenue or Net.
  const possibleTotal = pending.reduce((sum, w) => sum + w.amount, 0);
  const possible = {
    total: possibleTotal,
    byKind: { refund: pending.filter((w) => w.kind === "refund").reduce((t, w) => t + w.amount, 0), deposit: pending.filter((w) => w.kind === "deposit").reduce((t, w) => t + w.amount, 0), discount: pending.filter((w) => w.kind === "discount").reduce((t, w) => t + w.amount, 0) },
    items: pending.map((w, i) => ({ id: `pending:${i}`, kind: w.kind, kindLabel: PEND_NAMES[w.kind], name: `${w.bookingID || "—"} · ${customerOf(w.userID)}`, method: w.method, amount: w.amount, note: w.note })),
  };

  // ── payment records (created in the period) + who still owes ──
  const records = views.map((v) => {
    const paymentID = v.p.paymentID || v.p.id;
    const booking = bookingMap[v.p.bookingID] || null;
    const stage = derivePaymentStage(v.p, { bookingStatus: booking?.status || "", hasOpenRefund: openRefundPaymentIDs.has(paymentID) });
    const received = v.entries.filter((e) => e.direction === "in" && lower(e.status) === "success" && (e.phase === "deposit" || e.phase === "balance"));
    const methodNames = uniq(received.map((e) => methodLabel(e.method)));
    const userID = v.userID || v.p.userID || null;
    return {
      id: v.p.id, paymentID,
      bookingID: v.p.bookingID || "—",
      customer: customerOf(userID),
      car: v.carID ? (carNames[v.carID] || "Unknown Vehicle") : "—",
      total: num(v.p.amount), paid: v.amountPaid, balance: v.outstanding, refunded: v.refunded,
      stage,
      method: methodNames.length ? methodNames.join(" + ") : (v.p.paymentMethod ? methodLabel(v.p.paymentMethod) : "—"),
      reference: v.p.paymongoPaymentID || "—",
      createdAt: v.createdAt ? v.createdAt.toISOString() : null,
      tripStart: booking?.tripStart ? booking.tripStart.toISOString() : null,
      steps: v.entries
        .map((e) => ({ phase: e.phase, direction: e.direction, method: e.method ? methodLabel(e.method) : "—", amount: num(e.amount), status: e.status, reference: e.referenceNumber || "—", date: (toDate(e.settledAt) || toDate(e.createdAt))?.toISOString() || null }))
        .sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  });
  const unpaid = records
    .filter((r) => r.balance > 0 && (r.stage === "Partial" || r.stage === "Pending"))
    .sort((a, b) => b.balance - a.balance);

  // ── unpaid balances, shown inside Money in as the amount still EXPECTED under each method ──
  // A payment's expected method is the one already used for it (a Partial's deposit), else the one chosen at booking.
  // `total` stays what was actually received; `unpaid` is extra, and `barTotal` (received + expected) is the bar length.
  const unpaidByMethod = new Map();
  unpaid.forEach((r) => {
    const label = r.method === "—" ? "Other" : r.method.split(" + ")[0];
    const cur = unpaidByMethod.get(label) || { count: 0, amount: 0 };
    cur.count += 1; cur.amount += r.balance;
    unpaidByMethod.set(label, cur);
  });
  const methodRows = methodsReceived.map((m) => ({ ...m, unpaid: 0 }));
  unpaidByMethod.forEach((u, label) => {
    let row = methodRows.find((m) => m.id === label);
    if (!row) { row = { id: label, name: label, count: 0, ...blankParts(), total: 0, unpaid: 0, children: [] }; methodRows.push(row); }
    row.unpaid = u.amount;
    row.children = [...row.children, { id: `${label}:unpaid`, name: `Not yet paid (${u.count} payment${u.count === 1 ? "" : "s"})`, count: 0, ...blankParts(), total: 0, unpaid: u.amount, barTotal: u.amount }];
  });
  const methods = methodRows
    .map((m) => ({ ...m, barTotal: m.total + m.unpaid, children: m.children.map((c) => ({ ...c, unpaid: c.unpaid || 0, barTotal: c.barTotal ?? c.total })) }))
    .sort((a, b) => b.total - a.total || b.unpaid - a.unpaid);

  // ── Revenue & Expense on the finalization basis (see REVENUE BASIS above) ──
  const rsum = (kind) => revFlows.filter((f) => f.kind === kind).reduce((t, f) => t + f.amount, 0);
  const rRentals = rsum("rental"), rPenalties = rsum("penalty");
  const rRefunds = rsum("refund"), rDepositReturns = rsum("deposit_return"), rDiscountReturns = rsum("discount_return");
  const rReturned = rRefunds + rDepositReturns + rDiscountReturns;
  // "To return": deposits still held + refunds approved but not paid out yet (money that will go back, not revenue)
  const rDepositHeld = revFlows.reduce((t, f) => t + (f.kind === "rental" ? (f.deposit || 0) : f.kind === "pending_refund" ? f.amount : 0), 0) - revSettled.reduce((t, x) => t + x.amount, 0);
  const rRevenue = rRentals + rPenalties - rReturned - rDepositHeld;
  const revenueBasis = {
    cards: {
      rentals: rRentals, penalties: rPenalties, refunds: rRefunds, depositReturns: rDepositReturns, discountReturns: rDiscountReturns, returned: rReturned,
      depositsHeldBack: rDepositHeld, revenue: rRevenue, moneyIn: rRentals + rPenalties,
      maintenance: maintenanceTotal, gatewayFees: revFeesTotal, gatewayFeesUnrecorded: revFeeUnrecorded,
      net: rRevenue - maintenanceTotal - revFeesTotal,
    },
    series: revSeries,
    cars: revCars,
  };

  return {
    period, label,
    generatedAt: new Date().toISOString(),
    revenueBasis,
    cards: {
      rentals, penalties, refunds, depositReturns, discountReturns, returned,
      revenue, maintenance: maintenanceTotal, gatewayFees: fees.total, gatewayFeesUnrecorded: fees.unrecorded, possibleReturn: possible.total, depositsHeldBack: depositHeldChange, net: revenue - maintenanceTotal - fees.total,
      moneyIn: rentals + penalties,
      unpaid: unpaid.reduce((s, r) => s + r.balance, 0), unpaidCount: unpaid.length,
      depositsHeld, depositsKept: forfeited + depositUsed,
    },
    series, cars, methods, inParts, fees, outflows, possible, unpaid, payments: records,
  };
};

// "gcash" / "GCash" / "Bank Transfer" -> one label. Empty -> "—".
const METHOD_LABELS = { cash: "Cash", gcash: "GCash", maya: "Maya", qrph: "QR Ph", bank_transfer: "Bank transfer" };
const methodLabel = (m) => {
  const key = String(m ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key ? (METHOD_LABELS[key] || "Other") : "—";
};