import { login } from "../../controllers/auth/auth.controller.js";
import { sendOTP } from "../../controllers/otp/otp.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerAuthRoutes = (app) => {
  app.post("/api/auth/login", login);

  // Sends a verification code to the CALLER's own email (from their JWT).
  // Used as a confirmation step before sensitive actions like changing a
  // user's role — see PATCH /api/users/:uid/role in user.routes.js.
  app.post("/api/auth/send-otp", verifyToken, sendOTP);
};