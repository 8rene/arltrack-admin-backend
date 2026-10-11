import {
  driverAssignmentArchiveHandlers,
  cancellationRequestArchiveHandlers,
  paymentEntryArchiveHandlers,
} from "../../controllers/archives/linkedArchivesController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// View: Owner and Admin. Permanent delete: Owner only (irreversible), same as the other archives.
const allowed = [roles.OWNER, roles.ADMIN];
const deleteAllowed = [roles.OWNER];

const register = (app, path, handlers) => {
  app.get(`/api/archives/${path}`,              verifyToken, requireRole(allowed),       handlers.list);
  app.delete(`/api/archives/${path}/:archiveID`, verifyToken, requireRole(deleteAllowed), handlers.remove);
};

export const registerLinkedArchiveRoutes = (app) => {
  register(app, "driver-assignments",    driverAssignmentArchiveHandlers);
  register(app, "cancellation-requests", cancellationRequestArchiveHandlers);
  register(app, "payment-entries",       paymentEntryArchiveHandlers);
};
