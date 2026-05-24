import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { deleteUser, getUserByUid, getUserDetails } from "../../controllers/user/user.controller.js";

export const registerUserRoutes = (app) => {
  app.delete("/api/users/:uid", verifyToken, deleteUser);
  app.get("/api/users/by-uid/:uid", verifyToken, getUserByUid);
  app.get("/api/users/details/:uid", verifyToken, getUserDetails);
};
