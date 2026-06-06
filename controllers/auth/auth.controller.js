import { db } from "../../config/firebaseConnection/firebase.js";
import { generateToken } from "../../utils/jwt/jwt.util.js";
import { roleIDToName } from "../../utils/roles/role.util.js";
import admin from "firebase-admin";

export const login = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        message: "Authentication token is missing. Please log in again.",
      });
    }

    // 1. VERIFY FIREBASE ID TOKEN → get Firebase UID
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({
        message: "Your session token is invalid or has expired. Please log in again.",
      });
    }

    const firebaseUID = decodedToken.uid; // e.g. "6wR71LoZsvZMOXYAF6q4"
    const email = decodedToken.email;

    // 2. GET staffUser doc — document ID IS the Firebase UID
    const staffDocRef = db.collection("staffUser").doc(firebaseUID);
    const staffSnap = await staffDocRef.get();

    if (!staffSnap.exists) {
      return res.status(403).json({
        message: "Access denied. Your account does not have staff-level permissions.",
      });
    }

    const staffData = staffSnap.data();

    // 3. CHECK STATUS
    if (staffData.status && staffData.status.toLowerCase() !== "active") {
      return res.status(403).json({
        message: "Your staff account is currently inactive. Please contact your administrator.",
      });
    }

    // 4. GET userID from staffUser doc → use it to find user doc
    const userID = staffData.userID; // e.g. "JrDVMFT247gPfcA6DP8PG9OLLlt2"

    if (!userID) {
      return res.status(403).json({
        message: "Staff record has no linked user. Please contact your administrator.",
      });
    }

    // 5. GET user doc — document ID IS the userID
    const userDocRef = db.collection("user").doc(userID);
    const userSnap = await userDocRef.get();

    if (!userSnap.exists) {
      return res.status(403).json({
        message: "No user record found for this account. Please contact your administrator.",
      });
    }

    const userData = userSnap.data();
    const roleID = userData.roleID;

    if (!roleID) {
      return res.status(403).json({
        message: "User has no role assigned. Please contact your administrator.",
      });
    }

    // 6. RESOLVE roleName — try local map first, fallback to Firestore
    let roleName = roleIDToName(roleID);

    if (!roleName) {
      const roleSnap = await db.collection("roles").doc(roleID).get();
      if (!roleSnap.exists) {
        return res.status(403).json({
          message: "Your account role could not be determined. Please contact your administrator.",
        });
      }
      roleName = roleSnap.data().roleName;
    }

    // 7. GENERATE JWT
    const token = generateToken({
      uid: firebaseUID,
      email,
      role: roleName,
      roleID,
    });

    // 8. RESPOND
    return res.status(200).json({
      message: "Login successful. Welcome back.",
      token,
      user: {
        uid: firebaseUID,
        email,
        username: userData.username || "",
        role: roleName,
        roleID,
        profileImage: userData.profileImage || null,
      },
    });

  } catch (error) {
    console.error("[AUTH] Login error:", error);
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};