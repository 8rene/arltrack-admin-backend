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
  let totalRevenue = 0, totalPaid = 0, totalBalance = 0;
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
    const s = b.status || "pending";
    bookByStatus[s] = (bookByStatus[s] || 0) + 1;
    bookingRows.push({
      id:        doc.id,
      bookingID: b.bookingID || doc.id,
      status:    b.status   || "—",
      location:  b.location || "—",
      totalFee:  Number(b.totalFee || b.amount || 0),
      totalDays: b.totalDays || 0,
      startDate: toDate(b.startDateTime || b.startDate)?.toISOString() || null,
      endDate:   toDate(b.endDateTime   || b.endDate)?.toISOString()   || null,
      createdAt: toDate(b.createdAt)?.toISOString() || null,
    });
  });

  return {
    period,
    label,
    generatedAt: new Date().toISOString(),
    range: { start: start.toISOString(), end: end.toISOString() },
    summary: {
      totalRevenue,
      totalPaid,
      totalBalance,
      totalPayments: paymentRows.length,
      totalBookings,
      avgRevenuePerBooking: totalBookings > 0 ? Math.round(totalRevenue / totalBookings) : 0,
    },
    paymentsByGateway: byMethod,
    bookingsByStatus: Object.fromEntries(
      Object.entries(bookByStatus).filter(([k]) => ["completed", "cancelled"].includes(k.toLowerCase()))
    ),
    payments: paymentRows,
    bookings: bookingRows,
  };
};