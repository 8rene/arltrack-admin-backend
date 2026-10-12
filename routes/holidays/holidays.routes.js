import {
  getHolidays,
  addHoliday,
  editHoliday,
  removeHoliday,
  retraceHolidays,
} from "../../controllers/holidays/holidays.controller.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View / add / edit: Owner, Admin, Supervisor.
// Delete: Owner, Admin only — same split the original Holidays tab used
// (add/edit for everyone on the panel, delete only for the Admin panel).
const allowed = [roles.OWNER, roles.ADMIN, roles.SUPERVISOR];
const deleteAllowed = [roles.OWNER, roles.ADMIN];

export const registerHolidaysRoutes = (app) => {
  app.get   ("/api/holidays",         verifyToken, requireRole(allowed),       getHolidays);
  app.post  ("/api/holidays",         verifyToken, requireRole(allowed),       addHoliday);
  // "retrace" is registered before "/:id" so it is never captured as an id.
  app.post  ("/api/holidays/retrace", verifyToken, requireRole(allowed),       retraceHolidays);
  app.put   ("/api/holidays/:id",     verifyToken, requireRole(allowed),       editHoliday);
  app.delete("/api/holidays/:id",     verifyToken, requireRole(deleteAllowed), removeHoliday);
};
