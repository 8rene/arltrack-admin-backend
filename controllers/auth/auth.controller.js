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

    // 1. VERIFY FIREBASE ID TOKEN → get email + uid
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({
        message: "Your session token is invalid or has expired. Please log in again.",
      });
    }

    const firebaseUID = decodedToken.uid;
    const email = decodedToken.email;

    // 2. FIND staffUser by email field
    const staffSnap = await db
      .collection("staffUser")
      .where("email", "==", email)
      .get();

    if (staffSnap.empty) {
      return res.status(403).json({
        message: "Access denied. No staff account found with this email.",
      });
    }

    const staffData = staffSnap.docs[0].data();

    // 3. GET userID from staffUser doc
    const userID = staffData.userID;

    if (!userID) {
      return res.status(403).json({
        message: "Staff record has no linked user. Please contact your administrator.",
      });
    }

    // 4. GET user doc — doc ID is the userID
    const userSnap = await db.collection("user").doc(userID).get();

    if (!userSnap.exists) {
      return res.status(403).json({
        message: "No user record found for this account. Please contact your administrator.",
      });
    }

    const userData = userSnap.data();

    // 5. CHECK STATUS — the real, actively-enforced field (set by signup
    // verification and the license-expiry cron job). staffUser no longer
    // carries its own status; this is the only status check in login now.
    if (userData.status && ["inactive", "locked"].includes(userData.status.toLowerCase())) {
      return res.status(403).json({
        message:
          userData.status.toLowerCase() === "locked"
            ? "Your account is locked. Please contact your administrator."
            : "Your account is currently inactive. Please contact your administrator.",
      });
    }

    const roleID = userData.roleID;

    if (!roleID) {
      return res.status(403).json({
        message: "User has no role assigned. Please contact your administrator.",
      });
    }

    // 6. RESOLVE roleName — local map first, fallback to Firestore
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