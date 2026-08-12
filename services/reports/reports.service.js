import { db } from "../../config/firebaseConnection/firebase.js";

const toDate = (val) => {
  if (!val) return null;
  if (val?.toDate) return val.toDate();
  if (val?._seconds) return new Date(val._seconds * 1000);
  return new Date(val);
};

/**
 * Builds the date range for a report.
 *
 * All selections (year / month / week / day) are now EXPLICIT and come from
 * the user via the Reports tab dropdowns — we no longer silently default to
 * "today". `refDate` is only used as a last-resort fallback if a value is
 * missing (kept for backwards compatibility / safety).
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

/**
 * Resolves "Brand Model" display names for a set of carIDs.
 * Cars only store brandID/modelID — this joins against the `brand` and
 * `model` collections the same way fleet.service.js does for the fleet list.
 */
const resolveVehicleNames = async (carIDs) => {
  if (carIDs.length === 0) return {};

  const carRefs = carIDs.map((id) => db.collection("cars").doc(id));
  const carDocs = await db.getAll(...carRefs);

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
    const brandName = brandMap[c.brandID] || "";
    const modelName = modelMap[c.modelID] || "";
    names[carID] = [brandName, modelName].filter(Boolean).join(" ") || "Unknown Vehicle";
  });
  return names;
};

/**
 * Builds the Vehicle Report block: how many distinct cars were rented in the
 * period, revenue spread evenly across them, and the most/least rented car.
 */
const buildVehicleReport = async (bookingRows, totalPaid) => {
  const countByCarID = {};
  bookingRows.forEach((b) => {
    if (!b.carID) return;
    countByCarID[b.carID] = (countByCarID[b.carID] || 0) + 1;
  });

  const carIDs = Object.keys(countByCarID);
  const totalVehiclesRented = carIDs.length;
  const revenuePerVehicle = totalVehiclesRented > 0 ? Math.round(totalPaid / totalVehiclesRented) : 0;

  if (totalVehiclesRented === 0) {
    return { totalVehiclesRented: 0, revenuePerVehicle: 0, mostRented: null, leastRented: null, ranking: [] };
  }

  const names = await resolveVehicleNames(carIDs);

  const ranking = carIDs
    .map((carID) => ({ carID, name: names[carID], rentals: countByCarID[carID] }))
    .sort((a, b) => b.rentals - a.rentals);

  return {
    totalVehiclesRented,
    revenuePerVehicle,
    mostRented: ranking[0] || null,
    leastRented: ranking[ranking.length - 1] || null,
    ranking,
  };
};

/**
 * Builds the Customer Report block. "Customer" here means anyone who has
 * ever made a booking (the `user` collection also holds staff/admin/driver
 * accounts, so we scope by booking activity rather than roleID).
 *
 * - totalCustomers: distinct renters, all-time.
 * - newCustomersThisMonth: renters whose FIRST-EVER booking falls in the
 *   current real calendar month (not the selected report period).
 * - topCustomers: ranked by amount actually paid within the selected period.
 */
const buildCustomerReport = async (paymentRows) => {
  // All-time bookings, just to derive customer counts (kept lightweight —
  // only userID + createdAt are used).
  const allBookingsSnap = await db.collection("bookings").select("userID", "createdAt").get();

  const firstBookingByUser = {};
  allBookingsSnap.forEach((doc) => {
    const { userID, createdAt } = doc.data();
    if (!userID) return;
    const created = toDate(createdAt);
    if (!created) return;
    if (!firstBookingByUser[userID] || created < firstBookingByUser[userID]) {
      firstBookingByUser[userID] = created;
    }
  });

  const totalCustomers = Object.keys(firstBookingByUser).length;

  const now = new Date();
  const newCustomersThisMonth = Object.values(firstBookingByUser).filter(
    (d) => d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
  ).length;

  // Resolve bookingID -> userID for payments made in the selected period.
  // (A payment's own record doesn't store userID — only its bookingID.)
  const bookingIDs = [...new Set(paymentRows.map((p) => p.bookingID).filter((id) => id && id !== "—"))];
  const bookingUserMap = {};
  if (bookingIDs.length) {
    const bookingRefs = bookingIDs.map((id) => db.collection("bookings").doc(id));
    const bookingDocs = await db.getAll(...bookingRefs);
    bookingDocs.forEach((doc) => {
      if (doc.exists) bookingUserMap[doc.id] = doc.data().userID;
    });
  }

  const revenueByUser = {};
  paymentRows.forEach((p) => {
    const userID = bookingUserMap[p.bookingID];
    if (!userID) return;
    revenueByUser[userID] = (revenueByUser[userID] || 0) + p.amountPaid;
  });

  const rankedUserIDs = Object.entries(revenueByUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([userID]) => userID);

  let userNames = {};
  if (rankedUserIDs.length) {
    const userRefs = rankedUserIDs.map((id) => db.collection("user").doc(id));
    const userDocs = await db.getAll(...userRefs);
    userNames = Object.fromEntries(
      userDocs.map((d) => [d.id, d.exists ? (d.data().username || "Unknown") : "Unknown"])
    );
  }

  const topCustomers = rankedUserIDs.map((userID) => ({
    userID,
    name: userNames[userID] || "Unknown",
    amountPaid: revenueByUser[userID],
  }));

  return { totalCustomers, newCustomersThisMonth, topCustomers };
};

export const generateReport = async (period, selection = {}) => {
  const { start, end, label } = getRange(period, selection);

  const startTs = new Date(start);
  const endTs   = new Date(end);

  // Fetch payments in range
  const paySnap = await db.collection("payments")
    .where("createdAt", ">=", startTs)
    .where("createdAt", "<=", endTs)
    .orderBy("createdAt", "asc")
    .get();

  // Fetch bookings in range
  const bookSnap = await db.collection("bookings")
    .where("createdAt", ">=", startTs)
    .where("createdAt", "<=", endTs)
    .orderBy("createdAt", "asc")
    .get();

  /* ── Payment stats ── */
  let totalRevenue = 0, totalPaid = 0, totalBalance = 0, refundedAmount = 0;
  const byStatus   = {};
  const byMethod   = {};
  const paymentRows = [];

  paySnap.forEach((doc) => {
    const p = doc.data();
    const amount   = Number(p.amount)     || 0;
    const deposit  = Number(p.depositFee) || 0;
    const mop      = (p.methodOfPayment || "").toLowerCase();
    let amountPaid = 0;

    if (mop.includes("full"))         { amountPaid = amount; }
    else if (mop.includes("down"))    { amountPaid = Math.round(amount / 2); }
    else if (mop.includes("deposit")) { amountPaid = deposit; }
    else {
      amountPaid = ["paid","approved"].includes((p.status||"").toLowerCase()) ? amount : deposit;
    }

    let status = p.status || "Pending";
    if (status === "Paid") status = "Approved";

    totalRevenue += amount;
    totalPaid    += amountPaid;
    totalBalance += (amount - amountPaid);
    // Refunds aren't a payment "status" in this schema — they're tracked via
    // refundIssued (boolean) + refundDue (amount actually handed back).
    if (p.refundIssued) refundedAmount += Number(p.refundDue) || 0;

    byStatus[status] = (byStatus[status] || 0) + 1;
    // Normalize gateway name (prevents "gcash" vs "GCash" duplicates)
    const rawGw = p.paymentMethod || "Other";
    const gw = rawGw.toLowerCase() === "gcash" ? "GCash" : rawGw;
    byMethod[gw]     = (byMethod[gw]     || 0) + amountPaid;

    paymentRows.push({
      id:              doc.id,
      paymentID:       p.paymentID || doc.id,
      bookingID:       p.bookingID || "—",
      amount,
      amountPaid,
      balance:         amount - amountPaid,
      status,
      methodOfPayment: p.methodOfPayment || "—",
      paymentMethod:   p.paymentMethod   || "—",
      referenceNumber: p.referenceNumber || "—",
      createdAt:       toDate(p.createdAt)?.toISOString() || null,
    });
  });

  /* ── Booking stats ── */
  let totalBookings = 0;
  const bookByStatus = {};
  const bookingRows  = [];

  bookSnap.forEach((doc) => {
    const b = doc.data();
    totalBookings++;
    const s = (b.status || "pending").toLowerCase();
    bookByStatus[s] = (bookByStatus[s] || 0) + 1;
    bookingRows.push({
      id:        doc.id,
      bookingID: b.bookingID || doc.id,
      carID:     b.carID || null,
      status:    b.status   || "—",
      location:  b.location || "—",
      totalFee:  Number(b.totalFee || b.amount || 0),
      totalDays: b.totalDays || 0,
      startDate: toDate(b.startDateTime || b.startDate)?.toISOString() || null,
      endDate:   toDate(b.endDateTime   || b.endDate)?.toISOString()   || null,
      createdAt: toDate(b.createdAt)?.toISOString() || null,
    });
  });

  // Vehicle + Customer reports need their own joins (cars/model/brand, user)
  const [vehicleReport, customerReport] = await Promise.all([
    buildVehicleReport(bookingRows, totalPaid),
    buildCustomerReport(paymentRows),
  ]);

  return {
    period,
    label,
    generatedAt: new Date().toISOString(),
    range: { start: start.toISOString(), end: end.toISOString() },

    // Top-of-page stat cards (Total Sales / Number of Rentals / Average Sale)
    topStats: {
      totalSales:   totalPaid,
      numberOfRentals: totalBookings,
      averageSale:  totalBookings > 0 ? Math.round(totalPaid / totalBookings) : 0,
    },

    revenueReport: {
      totalRevenue,
      paidAmount: totalPaid,
      pendingAmount: totalBalance,
      refundedAmount,
    },

    rentalReport: {
      totalRentals: totalBookings,
      completed: bookByStatus["completed"] || 0,
      ongoing:   bookByStatus["ongoing"]   || 0,
      upcoming:  bookByStatus["upcoming"]  || 0,
      cancelled: bookByStatus["cancelled"] || 0,
    },

    vehicleReport,
    customerReport,

    // Kept for backwards compatibility / legacy summary consumers
    summary: {
      totalRevenue,
      totalPaid,
      totalBalance,
      totalPayments: paymentRows.length,
      totalBookings,
      avgRevenuePerBooking: totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0,
    },
    paymentsByGateway: byMethod,
    bookingsByStatus: bookByStatus,
    payments: paymentRows,
    bookings: bookingRows,
  };
};