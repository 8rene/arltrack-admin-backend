import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveRoleID, ROLE_LIST_VIEWABLE_BY, ROLE_IDS } from "../../utils/roles/role.util.js";
import { consumeOtp } from "../otp/otp.controller.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { resolveNotification } from "../../services/notification/notification.service.js";
import { upsertUserDocument } from "../../services/profileRequests/profileRequests.service.js";
import { generateUniqueReferralCode } from "../../utils/referral/referral.util.js";

const STAFF_ROLES = new Set([ROLE_IDS.ADMIN, ROLE_IDS.DRIVER, ROLE_IDS.SUPERVISOR]);

// Mirrors Users.jsx's KNOWN_STATUSES on the frontend — kept here too since
// PATCH /api/users/:uid/status is a real HTTP route, not something only
// reachable through that dropdown. Login (auth.controller.js) hardcodes
// this same ["inactive", "locked"] pairing, so any value outside this set
// would silently fail to block/unblock login as expected.
const VALID_USER_STATUSES = new Set(["active", "inactive", "locked"]);

/**
 * Keeps the `staffUser` collection (what auth.controller.js's login query
 * reads) in sync whenever a user's roleID changes. This is the ONLY place
 * that writes to `staffUser` — nothing else in the backend touches it, so
 * every role change MUST go through here or logins silently break again.
 *
 * Fields saved here are deliberately just: email, staffUserID, userID,
 * createdAt. roleID used to be stored here too, but nothing ever actually
 * reads staffUser.roleID anywhere in the codebase — the real permission
 * check in auth.controller.js reads roleID off the separate `user`
 * collection doc instead, via the userID looked up from here. So roleID
 * on this doc was dead weight that could go stale on its own. status was
 * removed for the same reason: it was always "active" and never actually
 * enforced anything; login now checks the real, actively-enforced
 * `user.status` field instead (see auth.controller.js). staffUserID is a
 * self-reference to this doc's own ID, so any code holding just the data
 * (not a live Firestore snapshot) still has it.
 *
 * - Moving INTO a staff role (Admin/Supervisor/Driver): create the
 *   staffUser doc if none exists yet for this uid, or update the existing
 *   one in place (never insert a second doc for the same uid/email —
 *   login's `.where("email","==",email)` query would then return
 *   whichever one Firestore happens to hand back first, which could be a
 *   stale duplicate).
 * - Moving OUT to Customer (or any non-staff role): delete the staffUser
 *   doc(s) for this uid so the account can no longer log into the admin
 *   panel.
 */
async function syncStaffUser(uid, newRoleID, email) {
  const existingSnap = await db.collection("staffUser").where("userID", "==", uid).get();

  if (STAFF_ROLES.has(newRoleID)) {
    if (!existingSnap.empty) {
      // Update in place; also clean up any accidental duplicates. Also
      // backfills staffUserID onto any doc created before this field
      // existed, and drops roleID going forward (existing roleID values
      // on old docs are simply left alone/ignored, not actively deleted,
      // since nothing reads them either way).
      const [first, ...dupes] = existingSnap.docs;
      await first.ref.update({ email, staffUserID: first.id });
      await Promise.all(dupes.map((d) => d.ref.delete()));
    } else {
      // Pre-generate the doc ID so staffUserID can be written in the same
      // set() call, instead of add() + a second update() just to learn
      // the ID Firestore assigned.
      const newRef = db.collection("staffUser").doc();
      await newRef.set({
        staffUserID: newRef.id,
        userID:      uid,
        email,
        createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  } else {
    // Not a staff role (e.g. Customer) — remove any staffUser doc(s) so
    // login is blocked going forward.
    await Promise.all(existingSnap.docs.map((d) => d.ref.delete()));
  }
}

/**
 * Adds referral info to each user object (list or single):
 *   referral: {
 *     code,                      // this user's own code (referralCode)
 *     referredBy: { id, username, name, code, removed } | null,
 *     invited:    [{ id, username, name, status, isVerified, createdAt }],
 *     invitedCount,
 *   }
 * Fields come from the customer backend's signup: referralCode (own code),
 * referredBy (referrer's userID), referredByCode (what they typed). Old accounts without them just get an
 * empty referral block. A referrer whose account was deleted shows up as
 * `removed: true` (the stored code is still shown).
 */
async function attachReferralInfo(users) {
  if (!users.length) return users;

  // 1. Everyone invited by someone in this list.
  const invitedByReferrer = new Map(); // referrerID -> [userDoc]
  const push = (d) => {
    const data = d.data();
    const key = data.referredBy;
    if (!invitedByReferrer.has(key)) invitedByReferrer.set(key, []);
    invitedByReferrer.get(key).push({ id: d.id, ...data });
  };
  if (users.length <= 5) {
    // Single-user / small lookups: targeted queries (avoids scanning all referred users).
    const snaps = await Promise.all(
      users.map((u) => db.collection("user").where("referredBy", "==", u.id).get())
    );
    snaps.forEach((s) => s.forEach(push));
  } else {
    // Full role list: one query for every referred user, grouped in memory.
    const snap = await db.collection("user").where("referredBy", "!=", null).get();
    snap.forEach(push);
  }

  // 2. Referrer docs for the users in this list.
  const referrerIDs = [...new Set(users.map((u) => u.referredBy).filter(Boolean))];
  const referrerDocs = new Map();
  for (let i = 0; i < referrerIDs.length; i += 100) {
    const refs = referrerIDs.slice(i, i + 100).map((id) => db.collection("user").doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((d) => { if (d.exists) referrerDocs.set(d.id, d.data()); });
  }

  // 3. Real names (userDetails is keyed by userID) for referrers + invitees.
  const nameIDs = new Set(referrerIDs);
  const listedIDs = new Set(users.map((u) => u.id));
  invitedByReferrer.forEach((list, referrerID) => {
    if (listedIDs.has(referrerID)) list.forEach((x) => nameIDs.add(x.id));
  });
  const nameMap = new Map();
  const nameIDList = [...nameIDs];
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
    const referrerData = u.referredBy ? referrerDocs.get(u.referredBy) : null;
    const code = u.referredByCode || null; // what they typed at signup (kept even if it matched nobody)
    let referredBy = null;
    if (u.referredBy || code) {
      referredBy = {
        id:       u.referredBy || null,
        username: referrerData?.username || null,
        name:     nameMap.get(u.referredBy) || null,
        code,
        removed:  !!u.referredBy && !referrerData,
      };
    }
    const invited = (invitedByReferrer.get(u.id) || [])
      .map((x) => ({
        id:         x.id,
        username:   x.username || null,
        name:       nameMap.get(x.id) || null,
        status:     x.status || null,
        isVerified: x.isVerified === true,
        createdAt:  x.createdAt || null,
      }));
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
async function referrerNote(userData) {
  try {
    if (!userData.referredBy) {
      return userData.referredByCode ? ` (entered referral code ${userData.referredByCode}, no match)` : "";
    }
    const r = await db.collection("user").doc(userData.referredBy).get();
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
    const users = await attachReferralInfo(snap.docs.map((d) => ({ id: d.id, ...d.data() })));

    return res.status(200).json({ success: true, data: users });
  } catch (error) {
    console.error("[USER] getUsersByRole error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ success: false, message: "User ID required." });

    const userDocRef = db.collection("user").doc(uid);
    const userDoc = await userDocRef.get();
    let deletedUserName = uid;

    if (userDoc.exists) {
      const userData = userDoc.data();
      deletedUserName = userData.username || userData.email || uid;

      // Archive user
      await db.collection("userArchives").add({
        ...userData,
        originalId: uid,
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

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
    }

    // Delete from Firebase Auth (uses UID which is the Firestore doc ID)
    try {
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      // Don't fail if auth user doesn't exist
      console.warn("[USER] Auth delete warning:", authErr.message);
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
      return res.status(200).json({ success: true, data: found });
    }
    const [withReferral] = await attachReferralInfo([{ id: userDoc.id, uid: userDoc.id, ...userDoc.data() }]);
    return res.status(200).json({ success: true, data: withReferral });
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

    await userDocRef.update({ isVerified });

    const name = userDoc.data().username || userDoc.data().email || uid;
    createAuditLog({
      action: "update",
      description: `${isVerified ? "Approved" : "Rejected"} ID document for ${name}${await referrerNote(userDoc.data())}.`,
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

    const name = userDoc.data().username || userDoc.data().email || uid;
    const unlocking = wasLocked && status !== undefined && String(status).toLowerCase() !== "locked";
    const refNote = unlocking ? await referrerNote(userDoc.data()) : "";
    createAuditLog({
      action: "update",
      description: `Updated account for ${name}${status !== undefined ? ` (status: ${status})` : ""}${isFlagged ? " — flagged" : ""}${refNote}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[USER] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: { id: uid, ...update } });
  } catch (error) {
    console.error("[USER] updateUserStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};