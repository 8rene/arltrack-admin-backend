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
export const createNotification = async ({ type, refID, refCollection, title, message, userID = null, extra = {}, renotify = false, dedupeKey = null }) => {
  // dedupeKey: for events that repeat on the SAME refID but are each their own thing (e.g. several penalties on one
  // booking, where refID is the booking). Without it the 2nd, 3rd... event would be swallowed by the first one's
  // still-active notification. With it, only a notification carrying the same key counts as a duplicate.
  // The key is filtered in memory, so no new Firestore index is needed.
  let base = db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("userID", "==", userID)
    .where("status", "==", "active");
  if (!dedupeKey) base = base.limit(1);
  const found = await base.get();
  const matches = dedupeKey ? found.docs.filter((d) => d.data().dedupeKey === dedupeKey) : found.docs;
  const existing = { empty: matches.length === 0, docs: matches };

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
    ...(dedupeKey ? { dedupeKey } : {}),
    userID,
    isRead: false,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  });

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
export const notifyStaff = async ({ type, refID, refCollection, title, message, extra = {}, renotify = false, dedupeKey = null }) => {
  const staffSnap = await db.collection("user")
    .where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN, ROLE_IDS.SUPERVISOR])
    .get();

  return Promise.all(
    staffSnap.docs.map((d) =>
      createNotification({ type, refID, refCollection, title, message, userID: d.id, extra, renotify, dedupeKey })
    )
  );
};

/**
 * Same fan-out as notifyStaff, but ONLY to Owners — for things the Owner
 * should see when somebody else did them (e.g. a Supervisor scheduling
 * maintenance), without pinging every Admin/Supervisor too.
 */
export const notifyOwners = async ({ type, refID, refCollection, title, message, extra = {}, renotify = false, dedupeKey = null }) => {
  const ownerSnap = await db.collection("user")
    .where("roleID", "==", ROLE_IDS.OWNER)
    .get();

  return Promise.all(
    ownerSnap.docs.map((d) =>
      createNotification({ type, refID, refCollection, title, message, userID: d.id, extra, renotify, dedupeKey })
    )
  );
};

/**
 * Fans a notification out to EVERY account in the `user` collection (customers
 * and all staff roles) — one doc per person, each with their own userID, so
 * isRead / dismiss stays personal to them, same as every other fan-out above.
 *
 * Unlike notifyStaff/notifyOwners this does NOT go through createNotification():
 * that runs a dedup query per person, which would be one extra read per user on
 * a collection that can be large. It isn't needed here — callers pass a refID
 * that is unique to the event (e.g. the new termsVersionID), so the same event
 * is only ever fanned out once.
 *
 * Users are read in pages of 400 (ids only — .select() with no fields skips the
 * document bodies) and written in one batch per page (Firestore caps a batch at
 * 500 writes). Resolves to how many users were notified.
 */
export const notifyAllUsers = async ({ type, refID, refCollection, title, message, extra = {} }) => {
  const PAGE = 400;
  let last = null;
  let count = 0;

  for (;;) {
    let q = db.collection("user")
      .select()
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((d) => {
      batch.set(db.collection("notifications").doc(), {
        type,
        refID,
        refCollection,
        title,
        message,
        ...extra,
        userID: d.id,
        isRead: false,
        status: "active",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        resolvedAt: null,
      });
    });
    await batch.commit();

    count += snap.size;
    if (snap.size < PAGE) break;
    last = snap.docs[snap.docs.length - 1];
  }

  return count;
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
};

/** Hard delete — used when the admin manually dismisses a notification (the "×" button). */
export const deleteNotification = async (notifID) => {
  await db.collection("notifications").doc(notifID).delete();
};