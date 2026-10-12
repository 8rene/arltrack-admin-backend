// What counts as revenue, in ONE place (the dashboard and the analytics charts used to disagree).
//   "approved" -> manually verified payments (bank transfer / cash proof approved by staff)
//   "paid"     -> automated PayMongo payments (GCash, Maya, QRPH) confirmed via webhook
// A payment also only counts while its booking still exists: a live payment whose booking is gone is an orphan
// (data left behind by a hard delete) and must not inflate the totals.
export const REVENUE_STATUSES = ["approved", "paid"];

export const isRevenueStatus = (status) => REVENUE_STATUSES.includes(String(status ?? "").trim().toLowerCase());

/** Set of every live booking key (the bookingID field, falling back to the doc id). Reads one field only. */
export const loadLiveBookingKeys = async (db) => {
  const snap = await db.collection("bookings").select("bookingID").get();
  const keys = new Set();
  snap.forEach((d) => { keys.add(d.id); const k = d.data().bookingID; if (k) keys.add(k); });
  return keys;
};

export const countsAsRevenue = (payment, liveBookingKeys) =>
  isRevenueStatus(payment.status) && liveBookingKeys.has(payment.bookingID);