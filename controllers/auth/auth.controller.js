import { db } from "../../config/firebaseConnection/firebase.js";
import { generateToken } from "../../utils/jwt/jwt.util.js";
import { roleIDToName } from "../../utils/roles/role.util.js";
import {
  createSessionLog,
  closeSessionLog,
  recordBlockedAttempt,
  expireStaleSessionsForUser,
} from "../../services/sessionLogs/sessionLogs.service.js";
import admin from "firebase-admin";

// Hardcoded per-app — this is the admin backend, so every session it opens
// is "admin_web". Never inferred from role, since a Driver account can log
// into this same panel as well as (potentially) a separate mobile app.
const PLATFORM = "admin_web";

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
      const blockedStatus = userData.status.toLowerCase();
      recordBlockedAttempt({
        uID: firebaseUID,
        username: userData.username || email,
        platform: PLATFORM,
        blockedReason: blockedStatus,
      }).catch((err) => console.error("[AUTH] Failed to write blocked session log:", err));
      return res.status(403).json({
        message:
          blockedStatus === "locked"
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

    // 8. LAZY EXPIRY CHECK — before opening a new session, sweep any of
    // this account's own sessions that are still marked "active" but
    // whose token would already have expired (e.g. they closed the tab
    // last time instead of logging out). Fire-and-forget: this is
    // housekeeping, never worth delaying or failing a real login over.
    expireStaleSessionsForUser(firebaseUID).catch((err) =>
      console.error("[AUTH] Failed to sweep stale sessions:", err)
    );

    // 9. LOG THE SESSION START. Login/logout no longer get a separate
    // Audit Log entry — Session Logs is the single source for this now,
    // so we're not writing the same event to two collections. We still
    // await this specifically because we need its ID back to give to the
    // frontend (so logout can close the right session).
    let sessionLogID = null;
    try {
      sessionLogID = await createSessionLog({
        uID: firebaseUID,
        username: userData.username || email,
        platform: PLATFORM,
      });
    } catch (err) {
      console.error("[AUTH] Failed to write session log:", err);
    }

    // 10. RESPOND
    return res.status(200).json({
      message: "Login successful. Welcome back.",
      token,
      sessionLogID,
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

// Closes out the sessionLogs entry created at login. req.user is set by
// verifyToken, so the identity here can't be spoofed by the client — only
// sessionLogID (which session to close) and reason come from the request
// body. reason distinguishes a normal logout from one the frontend forced
// because an admin locked/deleted/changed the role of this account while
// they were still logged in (see AuthContext.jsx's real-time listener) —
// that's a security-relevant event, not routine activity, so it's worth
// telling apart in the data. No separate Audit Log entry is written here
// anymore — Session Logs is the single source for login/logout now.
export const logout = async (req, res) => {
  try {
    const { sessionLogID, reason } = req.body;
    const closedReason = reason === "revoked" ? "revoked" : "manual";

    if (sessionLogID) {
      await closeSessionLog(sessionLogID, closedReason).catch((err) =>
        console.error("[AUTH] Failed to close session log:", err)
      );
    }

    return res.status(200).json({ message: "Logged out." });
  } catch (error) {
    console.error("[AUTH] Logout error:", error);
    return res.status(500).json({
      message: "An unexpected error occurred. Please try again.",
    });
  }
};