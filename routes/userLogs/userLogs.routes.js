import {
  listUserLogs,
  listUserLogsArchive,
  deleteUserLog,
} from "../../controllers/userLogs/userLogs.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerUserLogsRoutes = (app) => {
  app.get("/api/user-logs", verifyToken, listUserLogs);
  app.get("/api/user-logs-archive", verifyToken, listUserLogsArchive);
  app.delete("/api/user-logs/:id", verifyToken, deleteUserLog);
};
