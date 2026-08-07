import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveRoleID, ROLE_LIST_VIEWABLE_BY, ROLE_IDS } from "../../utils/roles/role.util.js";

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
    const users = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

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

    if (userDoc.exists) {
      const userData = userDoc.data();

      // Archive user
      await db.collection("userArchive").add({
        ...userData,
        originalId: uid,
        archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Archive + delete userDetails
      const detailsSnap = await db.collection("userDetails").where("userID", "==", uid).get();
      for (const d of detailsSnap.docs) {
        await db.collection("userDetailsArchive").add({ ...d.data(), originalId: uid, archivedAt: admin.firestore.FieldValue.serverTimestamp() });
        await d.ref.delete();
      }

      // Archive + delete userAddress
      const addressSnap = await db.collection("userAddress").where("userID", "==", uid).get();
      for (const d of addressSnap.docs) {
        await db.collection("userAddressArchive").add({ ...d.data(), originalId: uid, archivedAt: admin.firestore.FieldValue.serverTimestamp() });
        await d.ref.delete();
      }

      // Archive + delete userDocument
      const docSnap = await db.collection("userDocument").where("userID", "==", uid).get();
      for (const d of docSnap.docs) {
        await db.collection("userDocumentArchive").add({ ...d.data(), originalId: uid, archivedAt: admin.firestore.FieldValue.serverTimestamp() });
        await d.ref.delete();
      }

      // Delete user Firestore doc
      await userDocRef.delete();
    }

    // Delete from Firebase Auth (uses UID which is the Firestore doc ID)
    try {
      await admin.auth().deleteUser(uid);
    } catch (authErr) {
      // Don't fail if auth user doesn't exist
      console.warn("[USER] Auth delete warning:", authErr.message);
    }

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
      return res.status(200).json({ success: true, data: { id: snap.docs[0].id, ...snap.docs[0].data() } });
    }
    return res.status(200).json({ success: true, data: { id: userDoc.id, uid: userDoc.id, ...userDoc.data() } });
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
    const { role } = req.body;

    if (!uid) return res.status(400).json({ success: false, message: "User ID required." });
    if (!role) return res.status(400).json({ success: false, message: "role is required." });
    if (role === "Owner") {
      return res.status(403).json({ success: false, message: "Cannot assign the Owner role." });
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

    return res.status(200).json({ success: true, message: `Role updated to ${role}.` });
  } catch (error) {
    console.error("[USER] updateUserRole error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};