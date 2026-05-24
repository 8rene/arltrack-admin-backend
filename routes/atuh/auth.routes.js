import { login } from "../../controllers/auth/auth.controller.js";

export const registerAuthRoutes = (app) => {
  app.post("/api/auth/login", login);
};
