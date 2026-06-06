import { db } from "../../config/firebaseConnection/firebase.js";
import { generateToken } from "../../utils/jwt/jwt.util.js";
import { roleIDToName } from "../../utils/roles/role.util.js";
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

    // 3. FIND STAFF USER — staffUser collection, query by userID field
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

    // 4. CHECK STAFF STATUS
    if (staffData.status && staffData.status.toLowerCase() !== "active") {
      return res.status(403).json({
        message: "Your staff account is currently inactive. Please contact your administrator.",
      });
    }

    // 5. GET USER RECORD — user collection, query by userID field to get roleID
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

    const roleID = userData.roleID;

    if (!roleID) {
      return res.status(403).json({
        message: "User has no role assigned. Please contact your administrator.",
      });
    }

    // 6. RESOLVE ROLE NAME from roleID
    //    First try the local map (fast, no extra DB call)
    let roleName = roleIDToName(roleID);

    //    Fallback: if somehow a new role was added to Firestore not in the map
    if (!roleName) {
      const roleSnap = await db.collection("roles").doc(roleID).get();
      if (!roleSnap.exists) {
        return res.status(403).json({
          message: "Your account role could not be determined. Please contact your administrator.",
        });
      }
      roleName = roleSnap.data().roleName;
    }

    // 7. GENERATE JWT — embed roleName in token payload
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