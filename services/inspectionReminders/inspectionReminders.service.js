import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { getPhaseChecklist, describeMissingInspection } from "../vehicleDocumentation/vehicleDocumentation.service.js";
import { notifyStaff, resolveNotificationByField } from "../notification/notification.service.js";
import { auditSafe } from "../auditLogs/auditLogs.service.js";

// ─────────────────────────────────────────────
// "Remind Staff" — a driver who is blocked at Pickup/Return because the
// vehicle inspection isn't done yet can nudge Owner/Admin/Supervisor.
//
// The cooldown lives on the SERVER (inspectionReminders/{bookingKey}_{phase}),
// not in the browser, so refreshing the page or reopening My Trips can't
// reset it. One doc per booking + phase; the transaction in
// sendInspectionReminder is what makes two quick taps land as one reminder.
// ─────────────────────────────────────────────

export const INSPECTION_REMINDER_COOLDOWN_SECONDS = 10 * 60;

const COLLECTION = "inspectionReminders";

// before = Pickup (booking is "upcoming"), after = Return (booking is "ongoing").
const PHASES = {
  before: { type: "inspection_pickup_needed", requiredStatus: "upcoming", label: "pickup", title: "Pickup Inspection Needed" },
  after:  { type: "inspection_return_needed", requiredStatus: "ongoing",  label: "return", title: "Return Inspection Needed" },
};

const reminderDocID = (bookingKey, phase) => `${bookingKey}_${phase}`;

const httpError = (status, message, extra = {}) => {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
};

const toMs = (ts) => {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
};

const secondsLeft = (lastMs, nowMs = Date.now()) => {
  if (lastMs == null) return 0;
  return Math.max(0, Math.ceil((INSPECTION_REMINDER_COOLDOWN_SECONDS * 1000 - (nowMs - lastMs)) / 1000));
};

/**
 * { [bookingKey]: { before: { retryAfterSeconds }, after: { retryAfterSeconds } } }
 * for a batch of bookings — attached to each trip in My Trips so the Remind
 * Staff button can show the remaining cooldown straight after a page load.
 * Sent as seconds-remaining (not a timestamp) so a driver's phone clock
 * being off can't skew the countdown. Never throws: a failure here just
 * means the button shows as available, and the server still enforces it.
 */
export const getReminderCooldowns = async (bookingKeys = []) => {
  const keys = [...new Set(bookingKeys.filter(Boolean))];
  const out = {};
  if (!keys.length) return out;

  try {
    const refs = keys.flatMap((k) => [
      db.collection(COLLECTION).doc(reminderDocID(k, "before")),
      db.collection(COLLECTION).doc(reminderDocID(k, "after")),
    ]);
    const snaps = await db.getAll(...refs);
    const now = Date.now();
    keys.forEach((k, i) => {
      const before = snaps[i * 2];
      const after  = snaps[i * 2 + 1];
      out[k] = {
        before: { retryAfterSeconds: before.exists ? secondsLeft(toMs(before.data().lastRemindedAt), now) : 0 },
        after:  { retryAfterSeconds: after.exists  ? secondsLeft(toMs(after.data().lastRemindedAt),  now) : 0 },
      };
    });
  } catch (err) {
    console.error("[INSPECTION REMINDER] cooldown lookup failed:", err.message);
  }
  return out;
};

/**
 * Sends the reminder. Caller has already verified the booking belongs to
 * `driverID`. Throws an error with `.status` (400 not applicable, 429 still
 * cooling down — with `.retryAfterSeconds`) for the controller to relay.
 */
export const sendInspectionReminder = async ({ booking, bookingDocID, phase, driverID, driverName, vehicleName }) => {
  const cfg = PHASES[phase];
  if (!cfg) throw httpError(400, 'phase must be "before" or "after".');

  const bookingKey = booking.bookingID || bookingDocID;

  if ((booking.status || "").toLowerCase() !== cfg.requiredStatus) {
    throw httpError(
      400,
      phase === "before"
        ? "A pickup reminder can only be sent while the trip is still upcoming."
        : "A return reminder can only be sent while the trip is ongoing."
    );
  }

  const checklist = await getPhaseChecklist(bookingKey, phase);
  if (checklist.complete) {
    throw httpError(400, "The vehicle inspection is already complete — you can continue.");
  }

  // Reserve the cooldown slot first (transactionally), THEN notify. If the
  // notify step fails, the slot is handed back so a failed reminder doesn't
  // lock the driver out for 10 minutes with nothing actually sent.
  const ref   = db.collection(COLLECTION).doc(reminderDocID(bookingKey, phase));
  const nowTs = admin.firestore.Timestamp.now();
  let previous = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    previous = snap.exists ? snap.data() : null;

    const left = previous ? secondsLeft(toMs(previous.lastRemindedAt), nowTs.toMillis()) : 0;
    if (left > 0) {
      throw httpError(429, "Staff were already reminded recently.", { retryAfterSeconds: left });
    }

    tx.set(ref, {
      bookingKey,
      bookingDocID,
      phase,
      driverID,
      lastRemindedAt: nowTs,
      count: (previous?.count || 0) + 1,
    });
  });

  const missing = describeMissingInspection(checklist);

  try {
    await notifyStaff({
      type: cfg.type,
      refID: bookingDocID,
      refCollection: "bookings",
      title: cfg.title,
      message: `${driverName || "A driver"} is waiting on the ${cfg.label} inspection for ${vehicleName || "a vehicle"} (booking ${bookingKey}). Still missing: ${missing}.`,
      // carID + phase let the bell deep-link straight to that car's
      // inspection page; bookingKey is what resolves it once staff finish.
      extra: { carID: booking.carID || null, phase, bookingKey },
      renotify: true,
    });
  } catch (err) {
    if (previous) await ref.set(previous).catch(() => {});
    else await ref.delete().catch(() => {});
    throw err;
  }

  auditSafe({
    action: "update",
    description: `${driverName || "Driver"} sent a staff reminder to complete the ${cfg.label} vehicle inspection for booking ${bookingKey} (${vehicleName || "vehicle"}). Missing: ${missing}.`,
    userID: driverID,
    bookingID: bookingKey,
  });

  return {
    remindedAt: nowTs.toDate().toISOString(),
    retryAfterSeconds: INSPECTION_REMINDER_COOLDOWN_SECONDS,
    missing,
  };
};

/** Clears the reminder notification(s) for a booking — every staff member's copy at once. */
export const resolveInspectionReminders = async (bookingKey, phases = ["before", "after"]) => {
  if (!bookingKey) return;
  await Promise.all(
    phases
      .filter((p) => PHASES[p])
      .map((p) => resolveNotificationByField(PHASES[p].type, "bookingKey", bookingKey))
  );
};

/** Called after staff save part of an inspection: clears the reminder only once that phase is fully done. */
export const resolveInspectionReminderIfComplete = async (bookingKey, phase) => {
  if (!bookingKey || !PHASES[phase]) return;
  const checklist = await getPhaseChecklist(bookingKey, phase);
  if (checklist.complete) await resolveInspectionReminders(bookingKey, [phase]);
};