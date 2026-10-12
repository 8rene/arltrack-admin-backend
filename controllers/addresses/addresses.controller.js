import {
  LEVELS,
  listAddresses,
  createEntry,
  updateEntry,
  deleteEntry,
} from "../../services/addresses/addresses.service.js";
import { auditSafe } from "../../services/auditLogs/auditLogs.service.js";

const fail = (res, tag, error) => {
  console.error(`[ADDRESSES] ${tag} error:`, error);
  return res.status(error.statusCode || 500).json({ success: false, message: error.message });
};

const nameOf = (levelKey, row) => row[LEVELS[levelKey].nameField];
const nounOf = (levelKey) => (LEVELS[levelKey]?.noun || "Address").toLowerCase();

// GET /api/addresses  ->  { regions, provinces, municipalities, barangays }
export const getAddresses = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await listAddresses() });
  } catch (error) {
    return fail(res, "getAddresses", error);
  }
};

// POST /api/addresses/:level   Body: { name, parentID }
export const addAddress = async (req, res) => {
  try {
    const { level } = req.params;
    const data = await createEntry(level, req.body || {});
    auditSafe({ action: "create", description: `Added ${nounOf(level)} "${nameOf(level, data)}".`, userID: req.user?.uid || null });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, "addAddress", error);
  }
};

// PUT /api/addresses/:level/:id   Body: { name, parentID }
export const editAddress = async (req, res) => {
  try {
    const { level, id } = req.params;
    const data = await updateEntry(level, id, req.body || {});
    auditSafe({ action: "update", description: `Updated ${nounOf(level)} "${nameOf(level, data)}".`, userID: req.user?.uid || null });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, "editAddress", error);
  }
};

// DELETE /api/addresses/:level/:id
export const removeAddress = async (req, res) => {
  try {
    const { level, id } = req.params;
    const removed = await deleteEntry(level, id);
    auditSafe({ action: "delete", description: `Deleted ${nounOf(level)} "${nameOf(level, removed)}".`, userID: req.user?.uid || null });
    return res.status(200).json({ success: true, data: removed });
  } catch (error) {
    return fail(res, "removeAddress", error);
  }
};
