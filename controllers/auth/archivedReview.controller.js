import { db } from "../../config/firebaseConnection/firebase.js";
import { ROLE_IDS } from "../../utils/roles/role.util.js";
import { createNotification } from "../../services/notification/notification.service.js";

// ================================================================
// "Ask the administrator to check my account" -- the button on the login screen's archived message.
//
// Public on purpose (an archived account has no working login, so there is no token to check). Because of that it
// is only ever a REQUEST: it tells the Owners and Admins "this archived person is asking", it restores nothing,
// and staff still contact the person at the e-mail / phone on the archive record before deciding.
//
// - Same answer for every e-mail (archived or not, known or not), so this can't be used to find out which e-mails exist.
// - No free text is accepted, so there is nothing to read, filter or abuse.
// - One bell notification per Owner/Admin per archived account: createNotification() skips a copy that is
//   still active, so pressing the button again does nothing until staff resolve it (restore / permanent delete
//   clear it, or they dismiss it from the bell). No extra field or table is needed for that.
// - The per-IP limit is on the route (see routes/auth/auth.routes.js).
// Notification shape: type "archive_appeal", refCollection "userArchives", refID = the archived uid (the archive
// document's ID), so the bell opens Deleted Users on that person (Header.jsx / UserArchivePage.jsx).
// ================================================================

const SENT_MESSAGE = "Request sent. Staff will review your account and contact you.";

export const requestArchivedReview = async (req, res) => {
  try {
    const raw = req.body?.email;
    if (typeof raw !== "string") return res.status(400).json({ success: false, message: "Email is required." });
    const typed = raw.trim();
    if (!typed || typed.length > 254 || !typed.includes("@")) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    // Look the archive up by the e-mail as typed, then lowercased (older records may not be lowercase).
    const candidates = [...new Set([typed, typed.toLowerCase()])];
    let archiveDoc = null;
    for (const email of candidates) {
      const snap = await db.collection("userArchives").where("email", "==", email).limit(1).get();
      if (!snap.empty) { archiveDoc = snap.docs[0]; break; }
    }

    if (archiveDoc) {
      const data = archiveDoc.data();
      const who = data.username || data.email || archiveDoc.id;

      const staffSnap = await db.collection("user")
        .where("roleID", "in", [ROLE_IDS.OWNER, ROLE_IDS.ADMIN])
        .get();

      await Promise.all(
        staffSnap.docs.map((d) =>
          createNotification({
            type: "archive_appeal",
            refID: archiveDoc.id,
            refCollection: "userArchives",
            title: "Archived Account Review",
            message: `${who} (${data.email || typed}) is asking staff to check their archived account.`,
            userID: d.id,
          })
        )
      );
    }

    return res.status(200).json({ success: true, message: SENT_MESSAGE });
  } catch (error) {
    console.error("[AUTH] archived review request error:", error);
    return res.status(500).json({ success: false, message: "Couldn't send the request. Please try again." });
  }
};