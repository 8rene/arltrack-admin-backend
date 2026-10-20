// Recent activity for ONE customer — the Activity tab on Users > Customers. Read-only.
//
// Built from the customer's own rows (each is a plain `userID ==` query, so no composite index):
//   bookings -> "Booked" / "Trip completed"      cancellationRequests -> "Cancelled" / "Asked to cancel"
//   paymentEntries -> "Paid" / "Refunded"        penalties -> "Penalty"
// Archived bookings are not included: they are old by definition, and this is a "recent" feed.
import { db } from "../../config/firebaseConnection/firebase.js";

const MAX_EVENTS = 60;
const MAX_BOOKINGS = 40; // most recent bookings looked at (vehicle names are resolved for these only)

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  if (val._seconds !== undefined) return new Date(val._seconds * 1000);
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
};

const peso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
const PHASE = { deposit: "deposit", balance: "balance", penalty: "penalty", deposit_return: "deposit return", discount: "discount", discount_return: "discount credit return" };

const resolveVehicleName = async (carID) => {
  if (!carID) return "";
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    const modelID = carDoc.exists ? carDoc.data().modelID : null;
    if (!modelID) return "";
    const modelDoc = await db.collection("model").doc(modelID).get();
    if (!modelDoc.exists) return "";
    const { brandID, modelName } = modelDoc.data();
    const brandDoc = brandID ? await db.collection("brand").doc(brandID).get() : null;
    return [brandDoc?.exists ? brandDoc.data().brandName : "", modelName].filter(Boolean).join(" ");
  } catch { return ""; }
};

const byUser = (collection, uid) => db.collection(collection).where("userID", "==", uid).get();

export const getCustomerActivity = async (uid) => {
  if (!uid) throw new Error("uid is required.");
  const userDoc = await db.collection("user").doc(uid).get();
  if (!userDoc.exists) throw new Error("User not found.");

  const [bookingSnap, cancelSnap, entrySnap, penaltySnap] = await Promise.all([
    byUser("bookings", uid), byUser("cancellationRequests", uid), byUser("paymentEntries", uid), byUser("penalties", uid),
  ]);

  const events = [];
  const push = (type, at, text, bookingID = null, amount = null) => {
    const when = toJSDate(at);
    if (when) events.push({ type, at: when, text, bookingID, amount });
  };

  // Bookings: the newest ones only, with the vehicle named.
  const bookings = bookingSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (toJSDate(b.createdAt)?.getTime() ?? 0) - (toJSDate(a.createdAt)?.getTime() ?? 0))
    .slice(0, MAX_BOOKINGS);
  const carIDs = [...new Set(bookings.map((b) => b.carID).filter(Boolean))];
  const vehicleMap = Object.fromEntries(await Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))));
  bookings.forEach((b) => {
    const key = b.bookingID || b.id;
    const car = vehicleMap[b.carID] ? ` — ${vehicleMap[b.carID]}` : "";
    push("booked", b.createdAt, `Booked ${key}${car}`, key);
    if (b.completedAt) push("completed", b.completedAt, `Trip completed (${key})`, key);
  });

  cancelSnap.forEach((d) => {
    const c = d.data();
    const key = c.bookingID || null;
    if (c.cancelledBy) {
      // A direct cancellation row: the booking was cancelled, by the customer or by staff.
      const by = c.cancelledBy === "customer" ? "the customer" : c.cancelledBy === "refund" ? "a refund" : "staff";
      push("cancelled", c.createdAt || c.requestedAt, `Booking ${key || ""} cancelled by ${by}`.replace("  ", " "), key);
    } else {
      push("cancel_request", c.createdAt || c.requestedAt, `Asked to cancel ${key || "a booking"} (${c.status || "pending"})`, key);
    }
  });

  entrySnap.forEach((d) => {
    const e = d.data();
    if (e.status !== "success") return; // only money that actually moved
    const phase = PHASE[e.phase] || e.phase || "payment";
    const via = e.method ? ` via ${String(e.method).replace("_", " ")}` : "";
    if (e.direction === "out") push("refunded", e.settledAt || e.createdAt, `Refunded ${peso(e.amount)} (${phase})`, e.bookingID, e.amount);
    else push("paid", e.settledAt || e.createdAt, `Paid ${peso(e.amount)} — ${phase}${via}`, e.bookingID, e.amount);
  });

  penaltySnap.forEach((d) => {
    const p = d.data();
    const status = p.status && p.status !== "Confirmed" ? ` (${p.status})` : "";
    push("penalty", p.createdAt, `Penalty ${peso(p.amount)}${status}`, p.bookingID, p.amount);
  });

  return events
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_EVENTS)
    .map((e) => ({ ...e, at: e.at.toISOString() }));
};