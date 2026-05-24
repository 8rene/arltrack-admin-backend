import {
  listUserLogArchives,
  restoreUserLogArchiveHandler,
  deleteUserLogArchiveHandler,
} from "../../controllers/archives/userLogArchiveController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

export const registerUserLogArchiveRoutes = (app) => {
  // GET    /api/archives/user-log
  app.get("/api/archives/user-log", verifyToken, listUserLogArchives);

  // POST   /api/archives/user-log/:userLogArchivesId/restore
  app.post("/api/archives/user-log/:userLogArchivesId/restore", verifyToken, restoreUserLogArchiveHandler);

  // DELETE /api/archives/user-log/:userLogArchivesId
  app.delete("/api/archives/user-log/:userLogArchivesId", verifyToken, deleteUserLogArchiveHandler);
};
