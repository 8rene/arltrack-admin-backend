import { login, logout } from "../../controllers/auth/auth.controller.js";
import { sendOTP, checkOTP } from "../../controllers/otp/otp.controller.js";
import { sendPasswordResetOTP, resetAdminPassword } from "../../controllers/auth/passwordReset.controller.js";
import { changePassword } from "../../controllers/auth/changePassword.controller.js";
import { requestArchivedReview } from "../../controllers/auth/archivedReview.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { rateLimit } from "../../middlewares/rateLimit/rateLimit.middleware.js";

// Per-IP caps on what anyone can call without logging in (10-minute window). Wrong OTP guesses and resend timing are
// already limited per code / per e-mail in the OTP controllers; this stops floods and password guessing from one address.
// In-memory, so on Vercel each instance counts on its own -- see the middleware for the limits of that.
const authLimit = (keyPrefix, max) => rateLimit({ windowMs: 10 * 60 * 1000, max, keyPrefix });

export const registerAuthRoutes = (app) => {
  app.post("/api/auth/login", authLimit("admin-login", 20), login);

  // Closes the sessionLogs entry created at login (logoutDateTime +
  // sessionDuration) and writes a matching audit log entry. Requires a
  // valid token — if the token already expired, this will 401 and the
  // frontend just clears local storage anyway (see AuthContext.logout()).
  app.post("/api/auth/logout", verifyToken, logout);

  // Sends a verification code to the CALLER's own email (from their JWT).
  // Used as a confirmation step before sensitive actions like changing a
  // user's role — see PATCH /api/users/:uid/role in user.routes.js.
  app.post("/api/auth/send-otp", verifyToken, authLimit("admin-send-otp", 15), sendOTP);

  // Real-time "is this code actually right?" check — doesn't burn the code
  // (see peekOtp()'s comment in otp.controller.js), just gives immediate
  // feedback the moment someone finishes typing it. The action that
  // actually fires still does its own real, single-use check via
  // consumeOtp() at the moment it happens — this is a courtesy check.
  app.post("/api/auth/check-otp", verifyToken, checkOTP);

  // Forgot-password flow — deliberately NOT behind verifyToken, since this
  // is exactly for staff who can't log in at all. Counterpart to
  // customer-backend's /api/auth/send-otp (purpose: "reset") +
  // /api/auth/reset-password, which explicitly block staff accounts —
  // this is where those accounts are meant to reset their password instead.
  app.post("/api/auth/forgot-password/send-otp", authLimit("admin-forgot-otp", 10), sendPasswordResetOTP);
  app.post("/api/auth/forgot-password/reset",    authLimit("admin-forgot-reset", 10), resetAdminPassword);

  // "Ask the administrator to check my account" -- the button shown with the archived-login message. Not behind
  // verifyToken (an archived account can't sign in). Always answers the same; see the controller.
  app.post("/api/auth/archived-review", authLimit("admin-archived-review", 5), requestArchivedReview);

  // Logged-in "change my own password" flow, from Account settings.
  // Reuses POST /api/auth/send-otp above (with { purpose: "change-password" }
  // in the body) to email the code, then this consumes it and sets the
  // new password. See changePassword.controller.js for the full picture.
  app.patch("/api/auth/change-password", verifyToken, changePassword);
};