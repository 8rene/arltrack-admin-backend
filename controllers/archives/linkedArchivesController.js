// Archive pages for driverAssignmentArchives / cancellationRequestArchives / paymentEntryArchives.
// View + permanent delete of a single row. There is no standalone restore: these rows only mean something next
// to their booking, so they come back with it (restore of a booking, payment, penalty or refund archive).
import { listLinkedArchives, deleteLinkedArchive, LINKED } from "../../services/archives/linkedArchives.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

const makeHandlers = (kind) => {
  const label = LINKED[kind].label;
  const tag = `[${LINKED[kind].archive.toUpperCase()}]`;

  const list = async (req, res) => {
    try {
      const data = await listLinkedArchives(kind);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      console.error(`${tag} list error:`, error);
      return res.status(500).json({ success: false, message: error.message });
    }
  };

  const remove = async (req, res) => {
    try {
      const { archiveID } = req.params;
      await deleteLinkedArchive(kind, archiveID);
      createAuditLog({
        action: "delete",
        description: `Permanently deleted archived ${label} ${archiveID}.`,
        userID: req.user?.uid || null,
      }).catch((err) => console.error(`${tag} Failed to write audit log:`, err));
      return res.status(200).json({ success: true, message: `Archived ${label} permanently deleted.` });
    } catch (error) {
      console.error(`${tag} delete error:`, error);
      return res.status(400).json({ success: false, message: error.message });
    }
  };

  return { list, remove };
};

export const driverAssignmentArchiveHandlers    = makeHandlers("driverAssignments");
export const cancellationRequestArchiveHandlers = makeHandlers("cancellationRequests");
export const paymentEntryArchiveHandlers        = makeHandlers("paymentEntries");
