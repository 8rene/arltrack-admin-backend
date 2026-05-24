import { db } from "../../../arltrack-admin-backend/config/firebaseConnection/firebase.js";
import { generateToken } from "../../utils/jwt/jwt.util.js";
import { User } from "../../models/user/user.model.js";
import { StaffUser } from "../../models/staffUser/staffUser.model.js";
import { Role } from "../../models/role/role.model.js";
import admin from "firebase-admin";

export const login = async (req, res) => {
  try {
    const { idToken } = req.body;

    // 1. VALIDATE INPUT
    if (!idToken) {
      return res.status(400).json({
        message: "Authentication token is missing. Please log in again.",
      });
    }

    // 2. VERIFY FIREBASE ID TOKEN
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

    // 3. FIND USER IN FIRESTORE — using User model shape
    const userSnap = await db
      .collection("user")
      .where("userID", "==", firebaseUID)
      .get();

    if (userSnap.empty) {
      return res.status(403).json({
        message: "No user record found for this account. Please contact your administrator.",
      });
    }

    let userData;
    userSnap.forEach((doc) => { userData = doc.data(); });

    // 4. CHECK STAFF ACCESS — using StaffUser model shape
    const staffSnap = await db
      .collection("staffUser")
      .where("userID", "==", firebaseUID)
      .get();

    if (staffSnap.empty) {
      return res.status(403).json({
        message: "Access denied. Your account does not have staff-level permissions.",
      });
    }

    let staffData;
    staffSnap.forEach((doc) => { staffData = doc.data(); });

    // 5. CHECK STAFF STATUS
    if (staffData.status && staffData.status.toLowerCase() !== "active") {
      return res.status(403).json({
        message: "Your staff account is currently inactive. Please contact your administrator.",
      });
    }

    // 6. GET ROLE — using Role model shape
    const roleSnap = await db
      .collection("roles")
      .doc(staffData.RoleID || staffData.roleID)
      .get();

    if (!roleSnap.exists) {
      return res.status(403).json({
        message: "Your account role could not be determined. Please contact your administrator.",
      });
    }

    const role = roleSnap.data();

    // 7. GENERATE JWT
    const token = generateToken({
      uid: firebaseUID,
      email,
      role: role.name,
    });

    // 8. RESPOND
    return res.status(200).json({
      message: "Login successful. Welcome back.",
      token,
      user: {
        uid: firebaseUID,
        email,
        username: userData.username || "",
        role: role.name,
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
