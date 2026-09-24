import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { ROLE_IDS } from "../../utils/roles/role.util.js";

/**
 * Creates a notification IF one doesn't already exist for this
 * type + refID + userID combo (active, unresolved). Scoped by userID
 * now too — a fan-out event (e.g. cancellation_request going to every
 * Owner/Admin/Supervisor) writes one doc per person, and each person's
 * dedup check is independent: one person already having an active
 * notification never blocks another person's copy from being created.
 *
 * userID is optional — pass null/omit for a type that's still meant to
 * be a single shared doc (e.g. new_user, which every Owner/Admin/
 * Supervisor benefits from seeing and dismissing together).
 *
 * extra: optional extra fields stored on the doc (e.g. carID/phase for the
 * inspection reminders, so the bell can deep-link to the right page).
 *
 * renotify: by default an already-active notification is left untouched
 * (no duplicate, no re-ring). With renotify: true, that existing doc is
 * instead "bumped" — marked unread again, timestamp refreshed, message
 * updated — so a repeat of the same event (e.g. a driver tapping Remind
 * Staff again) rings the bell again without stacking a second copy.
 */
export const createNotification = async ({ type, refID, refCollection, title, message, userID = null, extra = {}, renotify = false }) => {
  const existing = await db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("userID", "==", userID)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (!existing.empty) {
    if (renotify) {
      await existing.docs[0].ref.update({
        title,
        message,
        ...extra,
        isRead: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    return existing.docs[0].id; // already active for this person, don't duplicate
  }

  const ref = await db.collection("notifications").add({
    type,
    refID,
    refCollection,
    title,
    message,
    ...extra,
    userID,
    isRead: false,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  });

  console.log(`[NOTIF] Created ${type} for ${refCollection}/${refID}${userID ? ` (userID: ${userID})` : ""}`);
  return ref.id;
};

/**
 * Fans a notification out to every Owner/Admin/Supervisor — one doc per
 * person, each with a real userID. Replaces the old pattern of a single
 * userID: null "global" doc (used to be geofence_alert, coding_alert,
 * pickup_overdue, return_overdue, license_expiring, license_expired,
 * refund_due). Drivers are intentionally excluded: they don't have
 * access to the tracker/device or a UI to act on these, so notifying
 * them added noise with nothing they could do about it.
 *
 * Reuses createNotification()'s own per-person dedup check — nothing
 * extra to do here, each person's active/inactive state is independent.
 */
export const notifyStaff = async ({ type, refID, refCollection, title, message, extra = {}, renotify = false }) => {
  const staffSnap = await db.collection("user")
    .where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN, ROLE_IDS.SUPERVISOR])
    .get();

  return Promise.all(
    staffSnap.docs.map((d) =>
      createNotification({ type, refID, refCollection, title, message, userID: d.id, extra, renotify })
    )
  );
};

/**
 * Marks every ACTIVE notification for this type+refID as resolved —
 * intentionally has no userID filter, so it resolves every fan-out copy
 * of the same event at once (e.g. every Owner/Admin/Supervisor's own
 * cancellation_request doc gets cleared together the moment the
 * underlying booking is approved/rejected, without needing to know how
 * many people were notified or who they were).
 *
 * Used for auto-clearing alerts: geofence/coding return to normal,
 * pickup/return happens, etc. Kept as a resolved doc rather than
 * deleted so there's a record it happened — the bell only shows
 * status == "active" ones.
 */
export const resolveNotification = async (type, refID) => {
  const snap = await db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("status", "==", "active")
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  snap.forEach((doc) => {
    batch.update(doc.ref, {
      status: "resolved",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`[NOTIF] Resolved ${type} for refID ${refID}`);
};

/**
 * Same as resolveNotification, but matches on an extra field instead of
 * refID — for notifications whose refID is a Firestore doc ID while the
 * caller only has a business key (e.g. the inspection reminders store the
 * booking's bookingID as `bookingKey` alongside a refID of the booking doc).
 */
export const resolveNotificationByField = async (type, field, value) => {
  const snap = await db.collection("notifications")
    .where("type", "==", type)
    .where(field, "==", value)
    .where("status", "==", "active")
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  snap.forEach((doc) => {
    batch.update(doc.ref, {
      status: "resolved",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`[NOTIF] Resolved ${type} where ${field} = ${value}`);
};

/** Hard delete — used when the admin manually dismisses a notification (the "×" button). */
export const deleteNotification = async (notifID) => {
  await db.collection("notifications").doc(notifID).delete();
};