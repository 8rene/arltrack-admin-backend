import { previewBookingDelete, deleteBookingWithCascade, DeleteBlockedError } from "../../services/booking/bookingDelete.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { ROLES } from "../../utils/roles/role.util.js";

// The ONLY delete in the system for a booking and everything that belongs to it (payment, payment entries, refunds,
// penalties, reviews, trip session, driver assignments, cancellation requests, maintenance, vehicle inspection).
// Payments, penalties and the rest have no delete of their own. "Delete" = archive.
//   GET    /api/bookings/:id/delete-preview   what would be archived + what is in the way. Writes nothing.
//   DELETE /api/bookings/:id[?force=true]     do it.
// Only Owner / Admin may delete past a blocker (open refund, ongoing trip, unpaid penalty, held deposit ...).
// A Supervisor never can, whatever the request says.
const canForce = (req) => [ROLES.OWNER, ROLES.ADMIN].includes(req.user?.role);
const wantsForce = (req) => req.query.force === "true" || req.body?.force === true;

const fail = (res, error) => {
  if (error instanceof DeleteBlockedError) {
    return res.status(409).json({ success: false, code: "BLOCKED", message: error.message, ...error.details });
  }
  if (/not found/i.test(error.message || "")) {
    return res.status(404).json({ success: false, code: "NOT_FOUND", message: `${error.message} It no longer exists, so there is nothing to delete (it may already have been deleted).` });
  }
  return res.status(400).json({ success: false, message: error.message });
};

export const previewDeleteHandler = async (req, res) => {
  try {
    const data = await previewBookingDelete(req.params.id);
    return res.status(200).json({ success: true, data: { ...data, canForce: canForce(req) } });
  } catch (error) {
    console.error("[BOOKING] delete preview error:", error);
    return fail(res, error);
  }
};

export const deleteHandler = async (req, res) => {
  try {
    const id = req.params.id;
    const archivedBy = req.user?.username || req.user?.uid || "admin";
    const result = await deleteBookingWithCascade(id, archivedBy, { force: wantsForce(req), canForce: canForce(req) });
    createAuditLog({
      action: "delete",
      description: `Archived booking ${result.bookingID} with all its records${result.forced ? " — forced past open items" : ""}.`,
      userID: req.user?.uid || null,
      bookingID: result.bookingID || null,
    }).catch((err) => console.error("[DELETE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: result.message, data: result });
  } catch (error) {
    console.error("[BOOKING] delete error:", error);
    return fail(res, error);
  }
};
