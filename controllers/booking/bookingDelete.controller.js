import {
  previewBookingDelete, deleteBookingWithCascade, previewItemDelete, deleteItem, DeleteBlockedError,
} from "../../services/booking/bookingDelete.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";
import { ROLES } from "../../utils/roles/role.util.js";

// One pair of handlers for the three "delete" screens (Bookings, Payments, Penalties). "Delete" = archive.
//   GET    …/:id/delete-preview   what would be archived + what is in the way. Writes nothing.
//   DELETE …/:id[?force=true]     do it.
// Only Owner / Admin may delete past a blocker (open refund, ongoing trip, unpaid penalty, held deposit ...).
// A Supervisor never can, whatever the request says.
const canForce = (req) => [ROLES.OWNER, ROLES.ADMIN].includes(req.user?.role);
const wantsForce = (req) => req.query.force === "true" || req.body?.force === true;

const IMPL = {
  booking: { preview: previewBookingDelete, remove: deleteBookingWithCascade },
  payment: { preview: (id) => previewItemDelete("payment", id), remove: (id, by, o) => deleteItem("payment", id, by, o) },
  penalty: { preview: (id) => previewItemDelete("penalty", id), remove: (id, by, o) => deleteItem("penalty", id, by, o) },
};

const fail = (res, error) => {
  if (error instanceof DeleteBlockedError) {
    return res.status(409).json({ success: false, code: "BLOCKED", message: error.message, ...error.details });
  }
  const notFound = /not found/i.test(error.message || "");
  if (notFound) return res.status(404).json({ success: false, code: "NOT_FOUND", message: `${error.message} It no longer exists, so there is nothing to delete (it may already have been deleted).` });
  return res.status(400).json({ success: false, message: error.message });
};

export const previewDeleteHandler = (kind, param = "id") => async (req, res) => {
  try {
    const data = await IMPL[kind].preview(req.params[param]);
    return res.status(200).json({ success: true, data: { ...data, canForce: canForce(req) } });
  } catch (error) {
    console.error(`[${kind.toUpperCase()}] delete preview error:`, error);
    return fail(res, error);
  }
};

export const deleteHandler = (kind, param = "id") => async (req, res) => {
  try {
    const id = req.params[param];
    const archivedBy = req.user?.username || req.user?.uid || "admin";
    const result = await IMPL[kind].remove(id, archivedBy, { force: wantsForce(req), canForce: canForce(req) });
    createAuditLog({
      action: "delete",
      description: result.mode === "alone"
        ? `Archived ${kind} ${id} on its own (its booking no longer exists)${result.forced ? " — forced past open items" : ""}.`
        : `Archived booking ${result.bookingID} with all its records${kind === "booking" ? "" : ` (deleted from the ${kind} page: ${id})`}${result.forced ? " — forced past open items" : ""}.`,
      userID: req.user?.uid || null,
      bookingID: result.bookingID || null,
    }).catch((err) => console.error("[DELETE] Failed to write audit log:", err));
    return res.status(200).json({ success: true, message: result.message, data: result });
  } catch (error) {
    console.error(`[${kind.toUpperCase()}] delete error:`, error);
    return fail(res, error);
  }
};