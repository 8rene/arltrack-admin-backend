import { db } from "../../config/firebaseConnection/firebase.js";
import { getEntriesForPaymentIDs } from "../paymentEntries/paymentEntries.service.js";
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
//              bookings count ("to pay" and anything unrecognised never do).
//   EXPENSE    Completed maintenance, dated by its maintenanceDate.
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
      out[doc.id] = { carID: b.carID || null, userID: b.userID || null, status: normalizeBookingStatus(b.status), tripStart: toDate(b.startDateTime || b.startDate) };
      if (b.bookingID) out[b.bookingID] = out[doc.id];
    });
  }
  return out;
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
  const [rowCarNames, rowUserNames] = await Promise.all([
    resolveVehicleNames(rowCarIDs),
    Promise.all(rowUserIDs.map((id) => resolveUserName(id).catch(() => "Unknown"))),
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

  const [maintenance, penSnap] = await Promise.all([
    loadMaintenanceExpenses(start, end),
    db.collection("penalties").where("createdAt", ">=", start).where("createdAt", "<=", end).get(),
  ]);

  const penalties = penSnap.docs.map((d) => d.data()).filter((p) => p.status === "Confirmed");
  const paidOf = (p) => Math.min(num(p.paidAmount), num(p.amount));

  const collectedByCar = {};
  const pairs = new Map();
  let penaltiesCollected = 0;
  let penaltiesPending = 0;
  const pendingUsers = new Set();

  penalties.forEach((p) => {
    const amount = num(p.amount);
    const paid = paidOf(p);
    const pending = Math.max(0, amount - paid);
    penaltiesCollected += paid;
    penaltiesPending += pending;
    if (pending > 0 && p.userID) pendingUsers.add(p.userID);
    if (p.carID) collectedByCar[p.carID] = (collectedByCar[p.carID] || 0) + paid;

    const key = `${p.userID || "?"}|${p.carID || "?"}`;
    const row = pairs.get(key) || { userID: p.userID || null, carID: p.carID || null, count: 0, total: 0, paid: 0 };
    row.count += 1; row.total += amount; row.paid += paid;
    pairs.set(key, row);
  });

  // ── cars: maintenance per car, split recovered / absorbed ──
  const maintByCar = new Map();
  maintenance.forEach((m) => {
    const cur = maintByCar.get(m.carID) || { carID: m.carID, name: m.carName, total: 0, jobs: 0 };
    cur.total += m.amount;
    cur.jobs += 1;
    maintByCar.set(m.carID, cur);
  });
  const cars = [...maintByCar.values()]
    .map((c) => {
      const recovered = Math.min(c.total, collectedByCar[c.carID] || 0);
      return { carID: c.carID, name: c.name, jobs: c.jobs, total: c.total, recovered, absorbed: c.total - recovered };
    })
    .sort((a, b) => b.total - a.total);
  const totalMaintenance = cars.reduce((s, c) => s + c.total, 0);

  // ── customers: one row per customer + car ──
  const pairRows = [...pairs.values()];
  const carNames = await resolveVehicleNames(uniq(pairRows.map((r) => r.carID)));
  const userIDs = uniq(pairRows.map((r) => r.userID));
  const userNames = {};
  await Promise.all(userIDs.map(async (id) => { userNames[id] = await resolveUserName(id).catch(() => "Unknown"); }));

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
  // One row per Confirmed penalty, with names. The Reports page groups these itself (by customer and by car),
  // so the graph and the table can be sorted, opened and paged without another request.
  const penaltyRows = penalties.map((p) => {
    const amount = num(p.amount);
    const paid = paidOf(p);
    return {
      userID: p.userID || null,
      carID: p.carID || null,
      customer: userNames[p.userID] || "Unknown",
      car: carNames[p.carID] || "Unknown Vehicle",
      amount,
      paid,
      pending: Math.max(0, amount - paid),
    };
  });

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
      penaltiesCollected,
      penaltiesPending,
      pendingCustomers: pendingUsers.size,
    },
    cars,
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
 *   Revenue = Rentals + Penalties - Returned          Net = Revenue - Maintenance (Completed only)
 *
 * PAYMENT RECORDS are the payments CREATED in the period, labelled with the Payments page's own derivePaymentStage().
 * Deposits held is a snapshot of right now (every payment whose deposit is still Held), not tied to the period.
 */
export const generateMoneyReport = async (period, selection = {}) => {
  const { start, end, label } = getRange(period, selection);
  const lower = (v) => String(v ?? "").trim().toLowerCase();

  const [entrySnap, settledSnap, heldSnap, paySnap, refundSnap, maintenance] = await Promise.all([
    db.collection(ENTRY_COLLECTION).where("settledAt", ">=", start).where("settledAt", "<=", end).get(),
    db.collection("payments").where("depositSettledAt", ">=", start).where("depositSettledAt", "<=", end).get(),
    db.collection("payments").where("depositStatus", "==", "Held").get(),
    db.collection("payments").where("createdAt", ">=", start).where("createdAt", "<=", end).orderBy("createdAt", "asc").get(),
    db.collection("refundRequests").where("status", "in", ["Pending", "Approved"]).get(),
    loadMaintenanceExpenses(start, end),
  ]);

  const entries = entrySnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => lower(e.status) === "success");
  const paymentDocs = paySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const settledDocs = settledSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => lower(p.depositStatus) === "settled");
  const openRefundPaymentIDs = new Set(refundSnap.docs.map((d) => d.data().paymentID).filter(Boolean));

  // ── one flat list of everything that moved ──
  const flows = [];   // { kind, date, bookingID, userID, amount, source, method }
  let forfeited = 0;
  entries.forEach((e) => {
    const date = toDate(e.settledAt);
    const amount = num(e.amount);
    if (!date || amount <= 0) return;
    const base = { date, bookingID: e.bookingID || null, userID: e.userID || null, amount, method: e.method || null,
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

  let depositUsed = 0;   // held deposits used to cover penalties: kept, nothing paid again
  settledDocs.forEach((p) => {
    const view = getDepositView(p);
    const date = toDate(p.depositSettledAt);
    if (!view || !date) return;
    depositUsed += num(view.deducted);
    if (num(view.returnedAmount) > 0) {
      flows.push({ kind: "deposit_return", date, bookingID: p.bookingID || null, userID: p.userID || null, amount: num(view.returnedAmount), source: "in_person", method: null });
    }
  });

  let depositsHeld = 0;
  heldSnap.docs.forEach((d) => { const v = getDepositView(d.data()); if (v && v.status === "Held") depositsHeld += num(v.amount); });

  // ── lookups ──
  const bookingMap = await loadBookingsByIDs([...flows.map((f) => f.bookingID), ...paymentDocs.map((p) => p.bookingID)]);
  const entriesByPayment = await getEntriesForPaymentIDs(paymentDocs.map((p) => p.paymentID || p.originalId || p.id));
  const views = buildPaymentViews(paymentDocs, entriesByPayment, bookingMap);

  flows.forEach((f) => {
    const b = bookingMap[f.bookingID];
    f.carID = b?.carID || null;
    if (!f.userID) f.userID = b?.userID || null;
  });

  const carIDs = uniq([...flows.map((f) => f.carID), ...maintenance.map((m) => m.carID), ...views.map((v) => v.carID)]);
  const userIDs = uniq([...flows.map((f) => f.userID), ...views.map((v) => v.userID || v.p.userID)]);
  const [carNames, userNames] = await Promise.all([resolveVehicleNames(carIDs), resolveUserNames(userIDs)]);
  const customerOf = (id) => (id && userNames[id] && userNames[id] !== "—" ? userNames[id] : "Unknown");

  // ── totals ──
  const sum = (kind) => flows.filter((f) => f.kind === kind).reduce((s, f) => s + f.amount, 0);
  const rentals = sum("rental"), penalties = sum("penalty");
  const refunds = sum("refund"), depositReturns = sum("deposit_return"), discountReturns = sum("discount_return");
  const returned = refunds + depositReturns + discountReturns;
  const revenue = rentals + penalties - returned;
  const maintenanceTotal = maintenance.reduce((s, m) => s + m.amount, 0);
  const signed = (f) => (f.kind === "rental" || f.kind === "penalty" ? f.amount : -f.amount);

  // ── time series: days (week / month / day) or months (year), every bucket listed so the chart has no gaps ──
  const g = period === "yearly" ? "month" : "day";
  const keyOf = (d) => (g === "month" ? `${d.getFullYear()}-${d.getMonth()}` : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  const buckets = new Map();
  for (let s = bucketStart(g, start); s <= end; s = g === "month" ? new Date(s.getFullYear(), s.getMonth() + 1, 1) : new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1)) {
    buckets.set(keyOf(s), {
      key: keyOf(s), label: bucketLabel(g, s),
      short: g === "month" ? monthShort(s.getMonth()) : period === "daily" ? `${monthShort(s.getMonth())} ${s.getDate()}` : String(s.getDate()),
      rentals: 0, penalties: 0, refunds: 0, depositReturns: 0, discountReturns: 0, returned: 0, maintenance: 0,
    });
  }
  flows.forEach((f) => {
    const b = buckets.get(keyOf(f.date));
    if (!b) return;
    if (f.kind === "rental") b.rentals += f.amount;
    else if (f.kind === "penalty") b.penalties += f.amount;
    else {
      // money that went back: kept apart so the report can show each one, and `returned` stays their total (Net is unchanged)
      if (f.kind === "refund") b.refunds += f.amount;
      else if (f.kind === "deposit_return") b.depositReturns += f.amount;
      else if (f.kind === "discount_return") b.discountReturns += f.amount;
      b.returned += f.amount;
    }
  });
  maintenance.forEach((m) => { const b = buckets.get(keyOf(new Date(m.date))); if (b) b.maintenance += m.amount; });
  const series = [...buckets.values()].map((b) => ({ ...b, revenue: b.rentals + b.penalties - b.returned, net: b.rentals + b.penalties - b.returned - b.maintenance }));

  // ── per car: what it brought in (net of what went back) against what maintenance cost ──
  const carMap = new Map();
  const carRow = (carID) => {
    const id = carID || "unknown";
    if (!carMap.has(id)) carMap.set(id, { id, carID: carID || null, revenue: 0, maintenance: 0, bookings: new Map(), jobs: [] });
    return carMap.get(id);
  };
  flows.forEach((f) => {
    const row = carRow(f.carID);
    row.revenue += signed(f);
    const bid = f.bookingID || "unknown";
    const cur = row.bookings.get(bid) || { bookingID: f.bookingID, userID: f.userID, net: 0 };
    cur.net += signed(f);
    row.bookings.set(bid, cur);
  });
  maintenance.forEach((m) => {
    const row = carRow(m.carID);
    row.maintenance += m.amount;
    row.jobs.push(m);
  });
  const cars = [...carMap.values()].map((r) => {
    const children = [
      ...[...r.bookings.values()].sort((a, b) => b.net - a.net).map((b) => ({
        id: `b:${b.bookingID}`, name: `${b.bookingID || "Booking"} · ${customerOf(b.userID)}`, revenue: b.net, maintenance: 0, net: b.net,
      })),
      ...r.jobs.sort((a, b) => b.amount - a.amount).map((m) => ({
        id: `m:${m.id}`, name: `Maintenance · ${m.services || m.basis || "Service"}`, revenue: 0, maintenance: m.amount, net: -m.amount,
      })),
    ];
    return {
      id: r.id, name: r.carID ? (carNames[r.carID] || "Unknown Vehicle") : "Unknown Vehicle",
      revenue: r.revenue, maintenance: r.maintenance, net: r.revenue - r.maintenance, bookings: r.bookings.size, children,
    };
  });

  // ── money in by method (opens into online / in person), money out by type ──
  const methodMap = new Map();
  flows.filter((f) => f.kind === "rental" || f.kind === "penalty").forEach((f) => {
    const label = methodLabel(f.method) === "—" ? "Other" : methodLabel(f.method);
    const m = methodMap.get(label) || { id: label, name: label, count: 0, rentals: 0, penalties: 0, total: 0, subs: new Map() };
    const sub = m.subs.get(f.source) || { id: `${label}:${f.source}`, name: f.source === "online" ? "Online (PayMongo)" : "In person", count: 0, rentals: 0, penalties: 0, total: 0 };
    [m, sub].forEach((t) => { t.count += 1; t.total += f.amount; if (f.kind === "rental") t.rentals += f.amount; else t.penalties += f.amount; });
    m.subs.set(f.source, sub);
    methodMap.set(label, m);
  });
  const methods = [...methodMap.values()].map(({ subs, ...m }) => ({ ...m, children: [...subs.values()].sort((a, b) => b.total - a.total) })).sort((a, b) => b.total - a.total);

  const OUT = [["refund", "Refunds"], ["deposit_return", "Deposit returns"], ["discount_return", "Discount returns"]];
  const outflows = OUT.map(([kind, name]) => {
    const rows = flows.filter((f) => f.kind === kind);
    const online = rows.filter((f) => f.source === "online").reduce((s, f) => s + f.amount, 0);
    const inPerson = rows.filter((f) => f.source !== "online").reduce((s, f) => s + f.amount, 0);
    // each transaction, newest first: what opens under the row
    const children = rows.slice().sort((x, y) => y.date - x.date).map((f, i) => ({
      id: `${kind}:${i}`,
      name: `${f.bookingID || "—"} · ${customerOf(f.userID)}`,
      date: f.date.toISOString(),
      method: methodLabel(f.method),
      online: f.source === "online" ? f.amount : 0,
      inPerson: f.source === "online" ? 0 : f.amount,
      total: f.amount,
    }));
    return { id: kind, name, count: rows.length, online, inPerson, total: online + inPerson, children };
  }).filter((r) => r.total > 0);

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

  return {
    period, label,
    generatedAt: new Date().toISOString(),
    cards: {
      rentals, penalties, refunds, depositReturns, discountReturns, returned,
      revenue, maintenance: maintenanceTotal, net: revenue - maintenanceTotal,
      moneyIn: rentals + penalties,
      unpaid: unpaid.reduce((s, r) => s + r.balance, 0), unpaidCount: unpaid.length,
      depositsHeld, depositsKept: forfeited + depositUsed,
    },
    series, cars, methods, outflows, unpaid, payments: records,
  };
};

// "gcash" / "GCash" / "Bank Transfer" -> one label. Empty -> "—".
const METHOD_LABELS = { cash: "Cash", gcash: "GCash", maya: "Maya", qrph: "QR Ph", bank_transfer: "Bank transfer" };
const methodLabel = (m) => {
  const key = String(m ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key ? (METHOD_LABELS[key] || "Other") : "—";
};