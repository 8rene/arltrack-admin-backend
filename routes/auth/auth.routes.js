import { login, logout } from "../../controllers/auth/auth.controller.js";
import { sendOTP } from "../../controllers/otp/otp.controller.js";
import { sendPasswordResetOTP, resetAdminPassword } from "../../controllers/auth/passwordReset.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerAuthRoutes = (app) => {
  app.post("/api/auth/login", login);

  // Closes the userLogs entry created at login (logoutDateTime +
  // sessionDuration) and writes a matching audit log entry. Requires a
  // valid token — if the token already expired, this will 401 and the
  // frontend just clears local storage anyway (see AuthContext.logout()).
  app.post("/api/auth/logout", verifyToken, logout);

  // Sends a verification code to the CALLER's own email (from their JWT).
  // Used as a confirmation step before sensitive actions like changing a
  // user's role — see PATCH /api/users/:uid/role in user.routes.js.
  app.post("/api/auth/send-otp", verifyToken, sendOTP);

  // Forgot-password flow — deliberately NOT behind verifyToken, since this
  // is exactly for staff who can't log in at all. Counterpart to
  // customer-backend's /api/auth/send-otp (purpose: "reset") +
  // /api/auth/reset-password, which explicitly block staff accounts —
  // this is where those accounts are meant to reset their password instead.
  app.post("/api/auth/forgot-password/send-otp", sendPasswordResetOTP);
  app.post("/api/auth/forgot-password/reset",    resetAdminPassword);
};