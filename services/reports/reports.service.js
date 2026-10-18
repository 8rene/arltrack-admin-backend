import { db } from "../../config/firebaseConnection/firebase.js";
import { getEntriesForPaymentIDs } from "../paymentEntries/paymentEntries.service.js";
import { hydratePayment } from "../paymentEntries/paymentEntries.mapper.js";
import { computeAmounts, normalizePaymentStatus } from "../payments/payments.service.js";
import { resolveUserName } from "../archives/resolveUserName.service.js";
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
      out[doc.id] = { carID: b.carID || null, userID: b.userID || null, status: normalizeBookingStatus(b.status) };
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
    .map((r) => ({ id: r.id, date: r.date.toISOString(), carName: names[r.carID] || "Unknown Vehicle", basis: r.basis, services: r.services, amount: r.amount }));
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

  const totalByBookingID = {};
  views.forEach((v) => { if (v.p.bookingID) totalByBookingID[v.p.bookingID] = num(v.p.amount); });
  const bookingRows = bookings
    .slice()
    .sort((a, b) => (a.startDateTime || 0) - (b.startDateTime || 0))
    .map((b) => ({
      id: b.id,
      bookingID: b.bookingID,
      carID: b.carID,
      status: b.status,
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