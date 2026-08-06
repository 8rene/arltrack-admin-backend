/**
 * userWatcher.js
 *
 * Every new signup starts with status: "locked" AND isVerified: false
 * (see the customer backend's models/user/user.model.js) — both flip at
 * the same time, at signup, with no separate re-submission flow in the
 * current codebase. So this is ONE notification per new signup ("new_user"),
 * not two — a split "new_document" type would just be a duplicate of the
 * same event right now. If document re-verification ever becomes its own
 * flow later, that's when it earns its own notification type.
 *
 * Resolves automatically the moment an admin unlocks the account
 * (status moves off "locked") from Customers.jsx.
 */

import { db } from "../config/firebaseConnection/firebase.js";
import { createNotification, resolveNotification } from "../services/notification/notification.service.js";

export const startUserWatcher = () => {
  console.log("🔔 [UserWatcher] Watching user signups for status changes...");

  const lastStatus = new Map();

  db.collection("user").onSnapshot(async (snap) => {
    for (const change of snap.docChanges()) {
      const docID = change.doc.id;
      const user  = change.doc.data();
      const status = user.status?.toLowerCase();

      if (change.type === "added") {
        lastStatus.set(docID, status);
        if (status === "locked") {
          await createNotification({
            type: "new_user",
            refID: docID,
            refCollection: "user",
            title: "New user signup",
            message: `${user.username || user.email || "A new user"} is waiting for account review.`,
          });
        }
        continue;
      }

      if (change.type === "modified") {
        const prev = lastStatus.get(docID);
        lastStatus.set(docID, status);

        if (prev === "locked" && status !== "locked") {
          await resolveNotification("new_user", docID);
        }
      }

      if (change.type === "removed") {
        lastStatus.delete(docID);
        await resolveNotification("new_user", docID);
      }
    }
  }, (err) => {
    console.error("[UserWatcher] Snapshot error:", err);
  });
};