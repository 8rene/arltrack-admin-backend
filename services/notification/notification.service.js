import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

/**
 * Creates a notification IF one doesn't already exist for this
 * type + refID combo (active, unresolved). Prevents duplicate bell
 * entries piling up from repeated triggers (e.g. multiple GPS pings
 * while a car stays outside its zone).
 */
export const createNotification = async ({ type, refID, refCollection, title, message }) => {
  const existing = await db.collection("notifications")
    .where("type", "==", type)
    .where("refID", "==", refID)
    .where("status", "==", "active")
    .limit(1)
    .get();

  if (!existing.empty) return existing.docs[0].id; // already active, don't duplicate

  const ref = await db.collection("notifications").add({
    type,
    refID,
    refCollection,
    title,
    message,
    isRead: false,
    status: "active",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    resolvedAt: null,
  });

  console.log(`[NOTIF] Created ${type} for ${refCollection}/${refID}`);
  return ref.id;
};

/**
 * Marks the active notification for this type+refID as resolved
 * (used for auto-clearing alerts: geofence/coding return to normal,
 * pickup/return happens, etc). Kept as a resolved doc rather than
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

/** Hard delete — used when the admin manually dismisses a notification (the "×" button). */
export const deleteNotification = async (notifID) => {
  await db.collection("notifications").doc(notifID).delete();
};