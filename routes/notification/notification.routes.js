import {
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  deleteAllNotifications,
} from "../../controllers/notification/notification.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";

// Any logged-in account (staff and drivers both have a bell) — each call only
// ever touches the caller's own notifications, so no role check is needed.
export const registerNotificationRoutes = (app) => {
  app.patch("/api/notifications/:id/read", verifyToken, markNotificationRead);
  app.post("/api/notifications/read-all",  verifyToken, markAllNotificationsRead);
  app.delete("/api/notifications/:id",     verifyToken, deleteNotification);
  app.delete("/api/notifications",         verifyToken, deleteAllNotifications);
};