import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveRoleID, roleIDToName, CUSTOMER_ROLE_ID, ROLE_LIST_VIEWABLE_BY, ROLE_IDS } from "../../utils/roles/role.util.js";
import { consumeOtp } from "../otp/otp.controller.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { resolveNotification, createNotification } from "../../services/notification/notification.service.js";
import { upsertUserDocument, closePendingRequestsForUser } from "../../services/profileRequests/profileRequests.service.js";
import { generateUniqueReferralCode } from "../../utils/referral/referral.util.js";
import { syncStaffUser } from "../../services/staffUser/staffUser.service.js";

// Role name for a stored roleID, including Customer (which roleIDToName deliberately doesn't know about).
const roleNameOf = (roleID) => roleIDToName(roleID) ?? (roleID === CUSTOMER_ROLE_ID ? "Customer" : null);

// What a customer is told when staff flag / unflag their account. Kept here (not in the frontend) so the wording
// is the same no matter which screen made the change. The restrictions themselves (no cancelling bookings, no
// reviews) are enforced by the customer backend, which reads user.isFlagged.
const FLAGGED_NOTICE = {
  title: "Your account has been flagged",
  message:
    "We're sorry to let you know that your account has been flagged. For now, you won't be able to cancel bookings " +
    "or leave reviews. If you think this is a mistake, please contact us or visit us in store.",
};
const UNFLAGGED_NOTICE = {
  title: "Your account flag was removed",
  message: "Good news — the flag on your account has been removed. You can cancel bookings and leave reviews again.",
};

// Mirrors Users.jsx's KNOWN_STATUSES on the frontend — kept here too since
// PATCH /api/users/:uid/status is a real HTTP route, not something only
// reachable through that dropdown. Login (auth.controller.js) hardcodes
// this same ["inactive", "locked"] pairing, so any value outside this set
// would silently fail to block/unblock login as expected.
const VALID_USER_STATUSES = new Set(["active", "inactive", "locked"]);

/**
 * Adds `lastActivityAt` (ISO string, or null) to each user in a role list: the newest of
 *   customers -> bookings (made / completed), cancellations, successful payments, penalties
 *   staff     -> their audit log entries
 *   everyone  -> last login (user.lastLoginAt)
 * Same events the Activity tab uses, so the column and the tab agree. One grouped read per
 * collection (same approach as attachReferralInfo's full-list branch), only the fields needed.
 */
async function attachLastActivity(users, isCustomerList) {
  if (!users.length) return users;
  const toMs = (v) => {
    if (!v) return 0;
    if (v.toMillis) return v.toMillis();
    if (v._seconds !== undefined) return v._seconds * 1000;
    const ms = new Date(v).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  };
  const latest = new Map(); // userID -> newest ms
  const bump = (uid, ...vals) => {
    if (!uid) return;
    const ms = Math.max(0, ...vals.map(toMs));
    if (ms > (latest.get(uid) || 0)) latest.set(uid, ms);
  };

  const reads = isCustomerList
    ? [
        db.collection("bookings").select("userID", "createdAt", "completedAt").get()
          .then((s) => s.forEach((d) => { const x = d.data(); bump(x.userID, x.createdAt, x.completedAt); })),
        db.collection("cancellationRequests").select("userID", "createdAt", "requestedAt").get()
          .then((s) => s.forEach((d) => { const x = d.data(); bump(x.userID, x.createdAt, x.requestedAt); })),
        db.collection("paymentEntries").select("userID", "status", "createdAt", "settledAt").get()
          .then((s) => s.forEach((d) => { const x = d.data(); if (x.status === "success") bump(x.userID, x.createdAt, x.settledAt); })),
        db.collection("penalties").select("userID", "createdAt").get()
          .then((s) => s.forEach((d) => { const x = d.data(); bump(x.userID, x.createdAt); })),
      ]
    : [
        db.collection("auditLogs").select("userID", "createdAt").get()
          .then((s) => s.forEach((d) => { const x = d.data(); bump(x.userID, x.createdAt); })),
      ];
  await Promise.all(reads);

  return users.map((u) => {
    const ms = Math.max(latest.get(u.id) || 0, toMs(u.lastLoginAt));
    return { ...u, lastActivityAt: ms ? new Date(ms).toISOString() : null };
  });
}

/**
 * Adds referral info to each user object (list or single):
 *   referral: {
 *     code,                      // this user's own code (referralCode)
 *     referredBy: { id, username, name, code, removed } | null,
 *     invited:    [{ id, username, name, status, isVerified, createdAt }],
 *     invitedCount,
 *   }
 * Everything comes from the "referrals" connection table
 * ({ referrerUserID, referredUserID, createdAt }) written by the customer
 * backend at signup; the user docs only supply names/status. A referrer
 * whose account was deleted shows up as `removed: true`. Invited accounts
 * that no longer exist are left out of `invited`.
 */
async function attachReferralInfo(users) {
  if (!users.length) return users;

  // 1. Referral rows involving anyone in this list.
  const rows = [];
  if (users.length <= 5) {
    // Single-user / small lookups: targeted queries (avoids scanning the whole table).
    const snaps = await Promise.all(users.flatMap((u) => [
      db.collection("referrals").where("referredUserID", "==", u.id).get(),
      db.collection("referrals").where("referrerUserID", "==", u.id).get(),
    ]));
    const seen = new Set();
    snaps.forEach((s) => s.forEach((d) => {
      if (!seen.has(d.id)) { seen.add(d.id); rows.push(d.data()); }
    }));
  } else {
    // Full role list: one read of the table, grouped in memory.
    const snap = await db.collection("referrals").get();
    snap.forEach((d) => rows.push(d.data()));
  }

  const referrerOf = new Map(); // referredUserID -> referrerUserID
  const invitedIDs = new Map(); // referrerUserID  -> [referredUserID]
  rows.forEach((r) => {
    referrerOf.set(r.referredUserID, r.referrerUserID);
    if (!invitedIDs.has(r.referrerUserID)) invitedIDs.set(r.referrerUserID, []);
    invitedIDs.get(r.referrerUserID).push(r.referredUserID);
  });

  // 2. User docs for the referrers of this list and for everyone these users invited.
  const listedIDs = new Set(users.map((u) => u.id));
  const referrerIDs = [...new Set(users.map((u) => referrerOf.get(u.id)).filter(Boolean))];
  const wantedIDs = new Set(referrerIDs);
  users.forEach((u) => (invitedIDs.get(u.id) || []).forEach((id) => wantedIDs.add(id)));

  const userData = new Map();
  const wantedList = [...wantedIDs];
  for (let i = 0; i < wantedList.length; i += 100) {
    const refs = wantedList.slice(i, i + 100).map((id) => db.collection("user").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((d) => { if (d.exists) userData.set(d.id, d.data()); });
  }

  // 3. Real names (userDetails is keyed by userID) for referrers + invitees.
  const nameMap = new Map();
  const nameIDList = [...userData.keys()];
  for (let i = 0; i < nameIDList.length; i += 100) {
    const refs = nameIDList.slice(i, i + 100).map((id) => db.collection("userDetails").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((d) => {
      if (!d.exists) return;
      const x = d.data();
      nameMap.set(d.id, `${x.firstName || ""} ${x.lastName || ""}`.trim());
    });
  }

  return users.map((u) => {
    const referrerID = referrerOf.get(u.id) || null;
    const referrerData = referrerID ? userData.get(referrerID) : null;
    const referredBy = referrerID
      ? {
          id:       referrerID,
          username: referrerData?.username || null,
          name:     nameMap.get(referrerID) || null,
          code:     referrerData?.referralCode || null,
          removed:  !referrerData,
        }
      : null;
    const invited = (invitedIDs.get(u.id) || [])
      .filter((id) => userData.has(id))
      .map((id) => {
        const x = userData.get(id);
        return {
          id,
          username:   x.username || null,
          name:       nameMap.get(id) || null,
          status:     x.status || null,
          isVerified: x.isVerified === true,
          createdAt:  x.createdAt || null,
        };
      });
    return {
      ...u,
      referral: {
        code:         u.referralCode || null,
        referredBy,
        invited,
        invitedCount: invited.length,
      },
    };
  });
}

/**
 * GET /api/users/me/referral
 *
 * Used by the admin panel's Account page (any role). Returns who referred the
 * logged-in account and who it has invited, read from the "referrals" table.
 * uid comes from the verified token, never from the request.
 */
export const getMyReferralInfo = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Not authenticated." });

    const [info] = await attachReferralInfo([{ id: uid }]);
    return res.status(200).json({
      success: true,
      data: { referredBy: info.referral.referredBy, invited: info.referral.invited },
    });
  } catch (error) {
    console.error("[USER] getMyReferralInfo error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/users/me/referral-code
 *
 * Used by the admin panel's Account page (any role). Returns the logged-in
 * account's own referral code, creating + saving one on its `user` doc the
 * first time if it doesn't have one yet — same "create it the first time
 * they open it" behaviour as the customer site's profile page. Only ever
 * touches the caller's OWN doc (uid comes from the verified token, never
 * from the request), and never touches the `staffUser` collection.
 */
export const ensureMyReferralCode = async (req, res) => {
  try {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ success: false, message: "Not authenticated." });

    const userRef = db.collection("user").doc(uid);
    const snap = await userRef.get();
    if (!snap.exists) return res.status(404).json({ success: false, message: "User not found." });

    const existing = snap.data().referralCode;
    if (existing) {
      return res.status(200).json({ success: true, data: { referralCode: existing }, created: false });
    }

    const candidate = await generateUniqueReferralCode();
    // Transaction so two page loads at the same time can't overwrite each
    // other with different codes — whichever lands first wins.
    const finalCode = await db.runTransaction(async (t) => {
      const cur = await t.get(userRef);
      if (cur.data()?.referralCode) return cur.data().referralCode;
      t.update(userRef, { referralCode: candidate });
      return candidate;
    });

    return res.status(200).json({ success: true, data: { referralCode: finalCode }, created: finalCode === candidate });
  } catch (error) {
    console.error("[USER] ensureMyReferralCode error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// " (referred by @juan)" for audit-log descriptions — added at the moments an
// admin acts on a new signup (verify ID / unlock). Never throws.
async function referrerNote(userID) {
  try {
    const rows = await db.collection("referrals").where("referredUserID", "==", userID).limit(1).get();
    if (rows.empty) return "";
    const r = await db.collection("user").doc(rows.docs[0].data().referrerUserID).get();
    if (!r.exists) return " (referred by an account that has since been removed)";
    return ` (referred by ${r.data().username || r.data().email || "a member"})`;
  } catch {
    return "";
  }
}

/**
 * GET /api/users?role=Customer|Driver|Supervisor|Admin
 *
 * Replaces the frontend querying Firestore directly with `where("roleID",
 * "==", <id>)`. That approach required the frontend to know each role's
 * Firestore doc ID (previously hardcoded, then briefly a broken dynamic
 * lookup) AND relied entirely on Firestore security rules to stop someone
 * reading other roles' data via devtools. This endpoint does the roleID
 * resolution here (role.util.js already owns that logic) and the actual
 * query with the Admin SDK, so client-side Firestore rules are no longer
 * the only thing standing between a logged-in user and this data.
 */
export const getUsersByRole = async (req, res) => {
  try {
    const { role } = req.query;
    if (!role) return res.status(400).json({ success: false, message: "role query param required." });

    const viewableBy = ROLE_LIST_VIEWABLE_BY[role];
    if (!viewableBy) return res.status(400).json({ success: false, message: `Unknown role "${role}".` });
    if (!viewableBy.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: `Your role does not have permission to view ${role} accounts.` });
    }

    const roleID = await resolveRoleID(role);
    if (!roleID) return res.status(404).json({ success: false, message: `Could not resolve an ID for role "${role}".` });

    const snap = await db.collection("user").where("roleID", "==", roleID).get();
    const withReferral = await attachReferralInfo(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const users = await attachLastActivity(withReferral, roleID === CUSTOMER_ROLE_ID);

    return res.status(200).json({ success: true, data: users });
  } catch (error) {
    console.error("[USER] getUsersByRole error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Delete guard: bookings that are still in play. A deleted account can't log in and can't be notified, so a customer or
// driver tied to one of these must not be deleted until the booking is finished or cancelled.
// ("completed", "cancelled" and "stolen" are over, so they don't block.)
const ACTIVE_BOOKING_STATUSES = ["to pay", "upcoming", "ongoing", "cancellation_request"];

// Returns { customerBookings: [bookingID...], driverBookings: [bookingID...] } of the active bookings tied to this uid.
// Filtering on status is done in code (not in the query) so no composite index is needed.
const findActiveBookingsFor = async (uid) => {
  const isActive = (status) => ACTIVE_BOOKING_STATUSES.includes(String(status || "").toLowerCase());

  // As a customer: bookings made by this user.
  const ownSnap = await db.collection("bookings").where("userID", "==", uid).get();
  const customerBookings = ownSnap.docs
    .filter((d) => isActive(d.data().status))
    .map((d) => d.data().bookingID || d.id);

  // As a driver: "assigned" rows whose booking is still active (a stale row on a finished booking doesn't block).
  const assignSnap = await db.collection("driverAssignments")
    .where("driverID", "==", uid).where("status", "==", "assigned").get();
  const driverBookings = [];
  for (const a of assignSnap.docs) {
    const bID = a.data().bookingID;
    if (!bID) continue;
    const bDoc = await db.collection("bookings").doc(bID).get();
    if (bDoc.exists && isActive(bDoc.data().status)) driverBookings.push(bDoc.data().bookingID || bDoc.id);
  }

  return { customerBookings, driverBookings };
};

const listIDs = (ids) => (ids.length <= 3 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`);

export const deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, message: "User ID required." });

    // Block the delete while this customer/driver still has an active or upcoming booking.
    const { customerBookings, driverBookings } = await findActiveBookingsFor(uid);
    if (customerBookings.length || driverBookings.length) {
      const parts = [];
      if (customerBookings.length) parts.push(`${customerBookings.length} active or upcoming booking(s) as the customer (${listIDs(customerBookings)})`);
      if (driverBookings.length) parts.push(`${driverBookings.length} active or upcoming booking(s) as the assigned driver (${listIDs(driverBookings)})`);
      return res.status(409).json({
        success: false,
        code: "ACTIVE_BOOKINGS",
        message: `This account can't be deleted yet: it has ${parts.join(" and ")}. Complete or cancel ${customerBookings.length + driverBookings.length > 1 ? "them" : "it"}${driverBookings.length ? " (or reassign the driver)" : ""} first, then try again.`,
        data: { customerBookings, driverBookings },
      });
    }

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();
    let deletedUserName = uid;

    if (userDoc.exists) {
      const userData = userDoc.data();
      deletedUserName = userData.username || userData.email || uid;

      // Archive user
      // The archive's document ID IS the user's uid (set, not add): restore puts the user back under the same ID and a retry
      // overwrites instead of duplicating.
      await db.collection("userArchives").doc(uid).set({
        ...userData,
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
        archivedBy: req.user?.uid || null, // userID of the staff member who deleted the account
      });

      // DISABLE the Firebase Auth login instead of deleting it: the account can't sign in (Firebase answers
      // "auth/user-disabled"), its password and email stay in place, and a restore only has to switch it back on.
      // The email also stays taken, so the customer can't sign up again as a second account. Done BEFORE the user doc
      // is removed so a failure here leaves everything as it was and the delete can simply be retried. The login is
      // deleted for good only when the archive is permanently deleted (deleteUserArchive).
      try {
        await admin.auth().updateUser(uid, { disabled: true });
        await admin.auth().revokeRefreshTokens(uid); // signed-in devices can't renew their session
      } catch (authErr) {
        // an account that never had a login (very old data) has nothing to disable
        if (authErr.code !== "auth/user-not-found") throw authErr;
        console.warn("[USER] No Auth account to disable:", authErr.message);
      }

      // NOTE: userDetails, userAddress, and userDocument are deliberately
      // left untouched here. They're not read anywhere the app exposes
      // without either a legitimate userID already in hand (from a
      // booking/payment/refund) or a scoped/authenticated lookup, and
      // profileRequests.service.js now checks the parent user still
      // exists before writing to them. The actual purge happens later,
      // in deleteUserArchive() (services/archives/userArchives.service.js),
      // when this archived record is permanently deleted — that's the
      // point of no return, not this soft-delete step.

      // Delete user Firestore doc
      await userDocRef.delete();

      // Delete any staffUser doc(s) so a removed account can't still log in.
      const staffSnap = await db.collection("staffUser").where("userID", "==", uid).get();
      await Promise.all(staffSnap.docs.map((d) => d.ref.delete()));

      // Pending profile-edit / ID-resubmit requests of this user would otherwise sit in the review queue for an
      // account that is gone: reject them (nothing is deleted yet; that happens at the permanent delete). Never blocks the delete.
      try {
        await closePendingRequestsForUser(uid, req.user?.uid || null);
      } catch (reqErr) {
        console.warn("[USER] Could not close pending requests:", reqErr.message);
      }
    }

    // No user doc means nothing was archived, so there is nothing to restore: clean up a leftover login (as before).
    // (An archived account's login was disabled above instead.)
    if (!userDoc.exists) {
      try {
        await admin.auth().deleteUser(uid);
      } catch (authErr) {
        // Don't fail if auth user doesn't exist
        console.warn("[USER] Auth delete warning:", authErr.message);
      }
    }

    createAuditLog({
      action: "delete",
      description: `Deleted and archived account for ${deletedUserName}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER] Failed to write audit log:", err));

    return res.status(200).json({ success: true, message: "User deleted and archived." });
  } catch (error) {
    console.error("[USER] Delete error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserByUid = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, message: "UID required." });

    const userDoc = await db.collection("user").doc(uid).get();
    if (!userDoc.exists) {
      // Try querying by uid field
      const snap = await db.collection("user").where("uid", "==", uid).limit(1).get();
      if (snap.empty) return res.status(404).json({ success: false, message: "User not found." });
      const [found] = await attachReferralInfo([{ id: snap.docs[0].id, ...snap.docs[0].data() }]);
      // `role` (name) is derived from the stored roleID; the doc itself only keeps roleID. The Audit Logs page uses it.
      return res.status(200).json({ success: true, data: { ...found, role: roleNameOf(found.roleID) } });
    }
    const [withReferral] = await attachReferralInfo([{ id: userDoc.id, uid: userDoc.id, ...userDoc.data() }]);
    return res.status(200).json({ success: true, data: { ...withReferral, role: roleNameOf(withReferral.roleID) } });
  } catch (error) {
    console.error("[USER] getUserByUid error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserDetails = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, message: "UID required." });

    const snap = await db.collection("userDetails").where("userID", "==", uid).limit(1).get();
    if (snap.empty) return res.status(404).json({ success: false, message: "User details not found." });

    const doc = snap.docs[0];
    return res.status(200).json({ success: true, data: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error("[USER] getUserDetails error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/users/:uid/role
 * Body: { role: "Customer" | "Driver" | "Supervisor" | "Admin" }
 *
 * Moves a user to a different role by pointing their `roleID` at the
 * target role's Firestore doc ID (resolved via role.util.js, same helper
 * getUsersByRole uses). Route-level `requireRole([roles.ADMIN])` is the
 * actual gate — this handler assumes it already ran.
 *
 * Deliberately does not accept "Owner" as a target: promoting an account
 * to Owner isn't something this endpoint should be able to do.
 */
export const updateUserRole = async (req, res) => {
  try {
    const { uid } = req.params;
    const { role, otp } = req.body;

    if (!uid) return res.status(400).json({ success: false, message: "User ID required." });
    if (!role) return res.status(400).json({ success: false, message: "role is required." });
    if (role === "Owner") {
      return res.status(403).json({ success: false, message: "Cannot assign the Owner role." });
    }

    // Require a fresh OTP, sent via POST /api/auth/send-otp to the ACTING
    // admin's own email, before a role change is applied. This is the
    // step that actually gates the action — everything below is unchanged
    // from before. Checked before resolveRoleID/user lookup so a bad or
    // missing code fails fast without doing extra Firestore reads.
    const verification = await consumeOtp(req.user.email, otp);
    if (!verification.ok) {
      return res.status(verification.status).json({ success: false, message: verification.message });
    }

    const roleID = await resolveRoleID(role);
    if (!roleID) return res.status(404).json({ success: false, message: `Could not resolve an ID for role "${role}".` });

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });

    // Belt-and-suspenders: Owner accounts currently have no tab in
    // Users.jsx and no key in ROLE_LIST_VIEWABLE_BY, so nothing in the UI
    // can ever select one as an edit target today. That's the real
    // protection. This check exists so that stays true even if this
    // endpoint is ever hit directly, or a future "Owner" tab gets added
    // without someone remembering to re-check this file.
    if (userDoc.data().roleID === ROLE_IDS.OWNER) {
      return res.status(403).json({ success: false, message: "Cannot change the role of an Owner account." });
    }

    await userDocRef.update({ roleID, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    // Keep staffUser (what login checks) in sync with the new role.
    await syncStaffUser(uid, roleID, userDoc.data().email || "");

    return res.status(200).json({ success: true, message: `Role updated to ${role}.` });
  } catch (error) {
    console.error("[USER] updateUserRole error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/users/:uid/verify
 * Body: { isVerified: boolean }
 *
 * Approves/rejects a user's uploaded ID document. Was previously a direct
 * `updateDoc(doc(db, "user", user.id), { isVerified: approve })` call from
 * both Customers.jsx and Users.jsx's DocumentsTab — moved here so it's
 * role-gated and audit-logged instead of any authenticated Firebase client
 * being able to write it directly.
 */
export const verifyUserDocument = async (req, res) => {
  try {
    const { uid } = req.params;
    const { isVerified, driverLicenseExpiry } = req.body;
    if (typeof isVerified !== "boolean") {
      return res.status(400).json({ success: false, message: "isVerified (boolean) is required." });
    }

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });

    // If this signup submitted a license and it's being approved, require
    // the expiry date as part of the same action — admin is already
    // looking at the physical card to approve it, so this is the one
    // moment to capture the date correctly rather than relying on a
    // separate, easy-to-forget follow-up via ExpiryField later.
    if (isVerified) {
      const docSnap = await db.collection("userDocument").where("userID", "==", uid).limit(1).get();
      const hasLicense = !docSnap.empty && !!docSnap.docs[0].data().driverLicenseUrl;
      if (hasLicense) {
        if (!driverLicenseExpiry) {
          return res.status(400).json({
            success: false,
            message: "driverLicenseExpiry is required when approving a document that includes a driver's license.",
          });
        }
        await upsertUserDocument(uid, { driverLicenseExpiry });
      }
    }

    // idReviewedBy / idReviewedAt: who made this call and when — shown as "Reviewed By" in the admin
    // panel's New ID view. Additive fields; older approvals simply don't have them.
    await userDocRef.update({
      isVerified,
      idReviewedBy: req.user?.uid || null,
      idReviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const name = userDoc.data().username || userDoc.data().email || uid;
    createAuditLog({
      action: "update",
      description: `${isVerified ? "Approved" : "Rejected"} ID document for ${name}${await referrerNote(userDoc.id)}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: { id: uid, isVerified } });
  } catch (error) {
    console.error("[USER] verifyUserDocument error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * PATCH /api/users/:uid/status
 * Body: { status, isFlagged }
 *
 * Edits a user's account status + flagged state. `status` is what
 * auth.controller.js's login checks to allow/block sign-in, so this write
 * has real access-control consequences — it was previously a direct
 * `updateDoc` from both Customers.jsx's EditUserModal and Users.jsx's
 * equivalent, with no server-side check on who could flip it.
 */
export const updateUserStatus = async (req, res) => {
  try {
    const { uid } = req.params;
    const { status, isFlagged } = req.body;

    if (isFlagged !== undefined && typeof isFlagged !== "boolean") {
      return res.status(400).json({ success: false, message: "isFlagged must be true or false." });
    }

    if (status !== undefined && !VALID_USER_STATUSES.has(String(status).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${[...VALID_USER_STATUSES].join(", ")}.`,
      });
    }

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists) return res.status(404).json({ success: false, message: "User not found." });

    const wasLocked = String(userDoc.data().status).toLowerCase() === "locked";
    // Only an actual change counts — re-saving an already-flagged account must not re-send the notice.
    const wasFlagged = userDoc.data().isFlagged === true;
    const flagChanged = isFlagged !== undefined && isFlagged !== wasFlagged;
    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (status !== undefined) update.status = status;
    if (isFlagged !== undefined) update.isFlagged = isFlagged;

    await userDocRef.update(update);

    // Resolved here directly rather than left to userWatcher.js to notice
    // via a Firestore onSnapshot() listener — same reasoning as the
    // refund-request fix: this admin backend runs as a Vercel serverless
    // function, so a background watcher isn't a reliable way to catch this.
    if (wasLocked && status !== undefined && String(status).toLowerCase() !== "locked") {
      resolveNotification("new_user", uid)
        .catch((err) => console.error("[USER] Failed to resolve notification:", err.message));
    }

    // Tell the customer (staff/driver accounts get the flag but no customer-facing notice).
    // renotify: if they were flagged before and an old notice is still active, it rings again instead of being dropped.
    if (flagChanged && userDoc.data().roleID === CUSTOMER_ROLE_ID) {
      const notice = isFlagged ? FLAGGED_NOTICE : UNFLAGGED_NOTICE;
      if (!isFlagged) {
        await resolveNotification("account_flagged", uid).catch((err) => console.error("[USER] Failed to resolve flag notice:", err.message));
      }
      createNotification({
        type: isFlagged ? "account_flagged" : "account_unflagged",
        refID: uid,
        refCollection: "user",
        userID: uid,
        title: notice.title,
        message: notice.message,
        renotify: true,
      }).catch((err) => console.error("[USER] Failed to notify customer about flag change:", err.message));
    }

    const name = userDoc.data().username || userDoc.data().email || uid;
    const unlocking = wasLocked && status !== undefined && String(status).toLowerCase() !== "locked";
    const refNote = unlocking ? await referrerNote(userDoc.id) : "";
    createAuditLog({
      action: "update",
      description: `Updated account for ${name}${status !== undefined ? ` (status: ${status})` : ""}${flagChanged ? (isFlagged ? " — FLAGGED (customer notified)" : " — flag removed") : ""}${refNote}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: { id: uid, ...update } });
  } catch (error) {
    console.error("[USER] updateUserStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};