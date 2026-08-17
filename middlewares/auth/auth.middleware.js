import jwt from "jsonwebtoken";
import { db } from "../../config/firebaseConnection/firebase.js";

export const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      message:
        "Authentication required. Please log in to access this resource.",
    });
  }

  let decoded;
  try {
    const token = authHeader.split(" ")[1];
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message:
          "Your session has expired. Please log in again to continue.",
      });
    }

    return res.status(401).json({
      message:
        "Your session is invalid or has been tampered with. Please log in again.",
    });
  }

  // Re-check current status on every request, not just at login — a token
  // issued while the account was active stays valid (per its own expiry)
  // even if it's set to "inactive" or "locked" afterward, unless we look
  // it up here. Fails closed: any lookup problem blocks the request rather
  // than letting a stale token through. Mirrors the check in
  // auth.controller.js's login.
  try {
    const userSnap = await db.collection("user").doc(decoded.uid).get();

    if (!userSnap.exists) {
      return res.status(403).json({
        message: "No user record found for this account. Please contact your administrator.",
      });
    }

    const status = userSnap.data().status?.toLowerCase();
    if (status === "locked" || status === "inactive") {
      return res.status(403).json({
        message:
          status === "locked"
            ? "Your account is locked. Please contact your administrator."
            : "Your account is currently inactive. Please contact your administrator.",
      });
    }
  } catch (error) {
    console.error("[AUTH] Middleware status check failed:", error.message);
    return res.status(500).json({
      message: "Server error. Please try again.",
    });
  }

  req.user = decoded;
  next();
};