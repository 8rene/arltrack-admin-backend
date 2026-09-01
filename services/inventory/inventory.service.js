import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";

const HISTORY_COLLECTIONS = {
  before: "inventoryBeforeTrip",
  after:  "inventoryAfterTrip",
};

/**
 * Admin-only direct edit of a single part's status on a before/after-trip
 * inspection record — upserts by bookingID, mirroring how
 * saveBeforeTrip/saveAfterTrip already look records up (not by doc ID).
 * This means it also covers the "driver never filled this out" case: if
 * no record exists yet for this booking, one gets created here instead of
 * erroring — Admin can set a trip's history from scratch, not just edit
 * an existing one.
 *
 * Deliberately bypasses saveBeforeTrip/saveAfterTrip's own logic — those
 * carry driver-flow side effects (RULE 1/2 damage notifications, the
 * after-trip "booking must be Completed" guard) that shouldn't fire when
 * an admin is correcting/backfilling closed-trip history after the fact.
 * This just writes the field and logs what changed — no notification, no
 * status guard, no dual-value "correction" UI, by design.
 */
export const adminUpdateHistoryPartStatus = async ({ tripPhase, bookingID, carID, carPartID, newStatus, editedBy }) => {
  const collectionName = HISTORY_COLLECTIONS[tripPhase];
  if (!collectionName) throw new Error('tripPhase must be "before" or "after".');
  if (!bookingID || !carPartID || !newStatus) {
    throw new Error("bookingID, carPartID, and newStatus are required.");
  }

  const existingSnap = await db.collection(collectionName).where("bookingID", "==", bookingID).limit(1).get();
  const isNewRecord = existingSnap.empty;

  let ref, damageParts, previousStatus;
  if (isNewRecord) {
    if (!carID) throw new Error("carID is required to create a new inspection record.");
    ref = db.collection(collectionName).doc();
    damageParts = [];
    previousStatus = "Good"; // nothing recorded before — every part defaults to Good
  } else {
    ref = existingSnap.docs[0].ref;
    const data = existingSnap.docs[0].data();
    damageParts = Array.isArray(data.damageParts) ? [...data.damageParts] : [];
    const idx = damageParts.findIndex((p) => p.carPartID === carPartID);
    previousStatus = idx >= 0 ? damageParts[idx].status : "Good";
  }

  const idx = damageParts.findIndex((p) => p.carPartID === carPartID);
  // Good/New parts simply aren't listed in damageParts — mirrors how
  // saveBeforeTrip/saveAfterTrip already filter these out on write.
  if (newStatus === "Good" || newStatus === "New") {
    if (idx >= 0) damageParts.splice(idx, 1);
  } else if (idx >= 0) {
    damageParts[idx] = { ...damageParts[idx], status: newStatus };
  } else {
    damageParts.push({ carPartID, status: newStatus });
  }

  const inventoryOverallStatus = damageParts.length > 0 ? "has damage" : "good";
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (isNewRecord) {
    await ref.set({
      bookingID, carID, damageParts, inventoryOverallStatus,
      recordedAt: now, lastEditedAt: now, lastEditedBy: editedBy || null,
      createdByAdmin: true, // this record didn't come from the driver app — flags where it came from
    });
  } else {
    await ref.update({ damageParts, inventoryOverallStatus, lastEditedAt: now, lastEditedBy: editedBy || null });
  }

  await createAuditLog({
    action: "update",
    description: isNewRecord
      ? `Vehicle inspection record created by admin (${tripPhase} trip, booking ${bookingID} — no driver-submitted record existed): part ${carPartID} set to "${newStatus}".`
      : `Vehicle inspection record edited (${tripPhase} trip, booking ${bookingID}): part ${carPartID} changed from "${previousStatus}" to "${newStatus}".`,
    userID: editedBy || null,
  });

  return { previousStatus, newStatus, inventoryOverallStatus, recordID: ref.id, isNewRecord };
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Resolve user full name from userID
 * Priority: userDetails.firstName + lastName → user.username → user.email
 */
const resolveUserName = async (userID) => {
  if (!userID) return "—";
  try {
    const [detailDoc, userDoc] = await Promise.all([
      db.collection("userDetails").doc(userID).get(),
      db.collection("user").doc(userID).get(),
    ]);
    const { firstName = "", lastName = "" } = detailDoc.exists ? detailDoc.data() : {};
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (fullName) return fullName;
    const { username = "", email = "" } = userDoc.exists ? userDoc.data() : {};
    return username || email || "—";
  } catch { return "—"; }
};

// ─────────────────────────────────────────────
// Get inventory records for a booking (both before + after)
// ─────────────────────────────────────────────
export const getInventoryByBooking = async (bookingID) => {
  const [beforeSnap, afterSnap] = await Promise.all([
    db.collection("inventoryBeforeTrip").where("bookingID", "==", bookingID).get(),
    db.collection("inventoryAfterTrip").where("bookingID", "==", bookingID).get(),
  ]);

  const pickLatest = (snap) => {
    if (snap.empty) return null;
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => {
      const ta = a.recordedAt?._seconds ?? 0;
      const tb = b.recordedAt?._seconds ?? 0;
      return tb - ta;
    });
    return docs[0];
  };

  return {
    before: pickLatest(beforeSnap),
    after:  pickLatest(afterSnap),
  };
};

// ─────────────────────────────────────────────
// Save / update Before Trip record
// Triggers RULE 1 notification if damage detected
// ─────────────────────────────────────────────
export const saveBeforeTrip = async ({ bookingID, carID, parts }) => {
  if (!bookingID || !carID || !Array.isArray(parts)) {
    throw new Error("bookingID, carID, and parts[] are required.");
  }

  const damageParts = parts.filter(p => p.status !== "Good" && p.status !== "New");
  const inventoryOverallStatus = damageParts.length > 0 ? "has damage" : "good";
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  // Upsert — check if a record already exists for this booking
  const existingSnap = await db
    .collection("inventoryBeforeTrip")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.update({ inventoryOverallStatus, damageParts, recordedAt: timestamp });
  } else {
    await db.collection("inventoryBeforeTrip").add({
      bookingID,
      carID,
      inventoryOverallStatus,
      damageParts,
      recordedAt: timestamp,
    });
  }

  // Damage notifications for this flow (before_trip_damage) were removed —
  // the old writeNotification() path here never set a `status` field, so
  // Header.jsx's `where("status","=="."active")` queries could never match
  // it; these docs were being written to Firestore but were structurally
  // invisible in the bell for every staff member, always. Not worth
  // reviving as-is; damageParts is still recorded on the inventory doc
  // above regardless, so the data itself isn't lost.

  return { success: true, inventoryOverallStatus, damageParts };
};

// ─────────────────────────────────────────────
// Save / update After Trip record
// Triggers RULE 2 notification per damaged/stolen part
// ─────────────────────────────────────────────
export const saveAfterTrip = async ({ bookingID, carID, parts, userID }) => {
  if (!bookingID || !carID || !Array.isArray(parts)) {
    throw new Error("bookingID, carID, and parts[] are required.");
  }

  // ── Guard: After Trip can only be saved if booking is completed ──
  const bookingSnap = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
  let bookingStatus = null;
  if (!bookingSnap.empty) {
    bookingStatus = bookingSnap.docs[0].data()?.status?.toLowerCase();
  } else {
    const directDoc = await db.collection("bookings").doc(bookingID).get();
    if (directDoc.exists) bookingStatus = directDoc.data()?.status?.toLowerCase();
  }
  if (bookingStatus !== "completed") {
    throw new Error(
      `Cannot save After Trip record: booking status is "${bookingStatus || "unknown"}". ` +
      `After Trip can only be saved once the booking is Completed.`
    );
  }

  const damageParts = parts.filter(p => ["Damaged", "Stolen", "Missing"].includes(p.status));
  const inventoryOverallStatus = damageParts.length > 0 ? "has damage" : "good";
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  // Upsert
  const existingSnap = await db
    .collection("inventoryAfterTrip")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    await existingSnap.docs[0].ref.update({ inventoryOverallStatus, damageParts, recordedAt: timestamp });
  } else {
    await db.collection("inventoryAfterTrip").add({
      bookingID,
      carID,
      inventoryOverallStatus,
      damageParts,
      recordedAt: timestamp,
    });
  }

  // Same as saveBeforeTrip above — after_trip_damage notifications removed,
  // same "status" field bug made them invisible in the bell regardless.
  // damageParts is still recorded on the inventory doc above.

  return { success: true, inventoryOverallStatus, damageParts };
};

// ─────────────────────────────────────────────
// Get nearest upcoming booking for a car
// Returns the approved/completed booking with the nearest startDateTime
// that hasn't ended yet (today or future)
// ─────────────────────────────────────────────
export const getNearestBookingForCar = async (carID) => {
  if (!carID) throw new Error("carID is required.");

  const snap = await db.collection("bookings").where("carID", "==", carID).get();
  const all  = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const nowSec = Date.now() / 1000;

  const toSec = (val) => {
    if (!val) return NaN;
    if (val?._seconds !== undefined) return val._seconds;
    if (typeof val?.toDate === "function") return val.toDate().getTime() / 1000;
    if (typeof val === "number") return val;
    const ms = new Date(val).getTime();
    return isNaN(ms) ? NaN : ms / 1000;
  };

  const upcoming = all
    .filter(b => {
      const status = b.status?.toLowerCase();
      if (!["approved", "completed"].includes(status)) return false;
      const endSec   = toSec(b.endDateTime);
      const startSec = toSec(b.startDateTime);
      return (!isNaN(endSec) && endSec > nowSec) || (!isNaN(startSec) && startSec >= nowSec - 86400);
    })
    .sort((a, b) => toSec(a.startDateTime) - toSec(b.startDateTime));

  if (!upcoming.length) return null;

  const booking = upcoming[0];
  const bID     = booking.bookingID || booking.id;

  // Resolve user name for the booking card display
  const userName = booking.userID ? await resolveUserName(booking.userID) : "—";

  return { ...booking, bookingID: bID, resolvedUserName: userName };
};