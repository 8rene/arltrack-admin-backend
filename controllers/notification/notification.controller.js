import { db } from "../../config/firebaseConnection/firebase.js";

// The bell in the admin Header reads `notifications` straight from Firestore
// (live listener), but marking read / deleting goes through here so it works
// no matter what the Firestore client rules allow. Everything is scoped to the
// caller's own copy (userID === req.user.uid): one person dismissing a
// notification never touches anybody else's copy of the same event.

const BATCH_SIZE = 400; // Firestore batches cap at 500 writes

const commitInChunks = async (docs, apply) => {
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    docs.slice(i, i + BATCH_SIZE).forEach((d) => apply(batch, d.ref));
    await batch.commit();
  }
};

// The caller's own ACTIVE notifications (what the bell shows), optionally narrowed by isRead.
const mine = (uid, isRead) => {
  let q = db.collection("notifications").where("userID", "==", uid).where("status", "==", "active");
  if (typeof isRead === "boolean") q = q.where("isRead", "==", isRead);
  return q.get();
};

const getOwned = async (req, res) => {
  const snap = await db.collection("notifications").doc(req.params.id).get();
  if (!snap.exists || snap.data().userID !== req.user?.uid) {
    res.status(404).json({ status: "error", message: "Notification not found." });
    return null;
  }
  return snap;
};

/** PATCH /api/notifications/:id/read */
export const markNotificationRead = async (req, res) => {
  try {
    const snap = await getOwned(req, res);
    if (!snap) return;
    if (snap.data().isRead !== true) await snap.ref.update({ isRead: true });
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[NOTIF] markNotificationRead error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to mark notification as read." });
  }
};

/** POST /api/notifications/read-all */
export const markAllNotificationsRead = async (req, res) => {
  try {
    const snap = await mine(req.user.uid, false);
    await commitInChunks(snap.docs, (batch, ref) => batch.update(ref, { isRead: true }));
    return res.json({ status: "ok", updated: snap.size });
  } catch (err) {
    console.error("[NOTIF] markAllNotificationsRead error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to mark notifications as read." });
  }
};

/** DELETE /api/notifications/:id */
export const deleteNotification = async (req, res) => {
  try {
    const snap = await getOwned(req, res);
    if (!snap) return;
    await snap.ref.delete();
    return res.json({ status: "ok" });
  } catch (err) {
    console.error("[NOTIF] deleteNotification error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to delete notification." });
  }
};

/** DELETE /api/notifications?scope=all|read — clear the caller's own notifications */
export const deleteAllNotifications = async (req, res) => {
  try {
    const onlyRead = req.query.scope === "read";
    const snap = await mine(req.user.uid, onlyRead ? true : undefined);
    await commitInChunks(snap.docs, (batch, ref) => batch.delete(ref));
    return res.json({ status: "ok", deleted: snap.size });
  } catch (err) {
    console.error("[NOTIF] deleteAllNotifications error:", err.message);
    return res.status(500).json({ status: "error", message: "Failed to clear notifications." });
  }
};