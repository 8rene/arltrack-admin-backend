import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { ROLE_IDS } from "../../utils/roles/role.util.js";

// Roles that log into the admin panel, so they need a staffUser doc (Owner is never created or removed through the app).
export const STAFF_ROLES = new Set([ROLE_IDS.ADMIN, ROLE_IDS.DRIVER, ROLE_IDS.SUPERVISOR]);

/**
 * Keeps the `staffUser` collection (what auth.controller.js's login query
 * reads) in sync whenever a user's roleID changes. This is the ONLY place
 * that writes to `staffUser` — nothing else in the backend touches it, so
 * every role change (and every restore of an archived account) MUST go
 * through here or logins silently break again.
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
export async function syncStaffUser(uid, newRoleID, email) {
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
    return true;
  } else {
    // Not a staff role (e.g. Customer) — remove any staffUser doc(s) so
    // login is blocked going forward.
    await Promise.all(existingSnap.docs.map((d) => d.ref.delete()));
    return false;
  }
}