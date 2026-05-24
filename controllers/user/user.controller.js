import { db } from "../../../arltrack-admin-backend/config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

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
