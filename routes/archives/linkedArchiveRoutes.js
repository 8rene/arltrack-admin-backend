import {
  driverAssignmentArchiveHandlers,
  cancellationRequestArchiveHandlers,
  paymentEntryArchiveHandlers,
} from "../../controllers/archives/linkedArchivesController.js";
import { verifyToken } from "../../middlewares/auth/auth.middleware.js";
import { requireRole, roles } from "../../middlewares/role/role.middleware.js";

// Read-only. Permanent delete is done from the Booking Archive only (it takes the whole booking).
const allowed = [roles.OWNER, roles.ADMIN];

const register = (app, path, handlers) => {
  app.get(`/api/archives/${path}`,              verifyToken, requireRole(allowed),       handlers.list);
};

export const registerLinkedArchiveRoutes = (app) => {
  register(app, "driver-assignments",    driverAssignmentArchiveHandlers);
  register(app, "cancellation-requests", cancellationRequestArchiveHandlers);
  register(app, "payment-entries",       paymentEntryArchiveHandlers);
};
