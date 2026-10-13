import {
  listCodingRules,
  createRule,
  createCity,
  updateRule,
  deleteRule,
  deleteCity,
} from "../../services/codingRules/codingRules.service.js";
import { auditSafe } from "../../services/auditLogs/auditLogs.service.js";

const fail = (res, tag, error) => {
  console.error(`[CODING_RULES] ${tag} error:`, error);
  return res.status(error.statusCode || 500).json({ success: false, message: error.message });
};

const describe = (r) =>
  `${r.city} — ${r.dayName} ${r.startTime}–${r.endTime}, banned digits ${r.bannedDigits.join(", ")}`;

// GET /api/coding-rules  ->  { cities: [...], rules: [...] }
export const getCodingRules = async (req, res) => {
  try {
    const data = await listCodingRules();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, "getCodingRules", error);
  }
};

// POST /api/coding-rules
// Body: { city, dayName, startTime, endTime, bannedDigits }
export const addCodingRule = async (req, res) => {
  try {
    const data = await createRule(req.body || {});
    auditSafe({ action: "create", description: `Added coding rule: ${describe(data)}.`, userID: req.user?.uid || null });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, "addCodingRule", error);
  }
};

// POST /api/coding-rules/city
// Body: { city, rules: [{ dayName, startTime, endTime, bannedDigits }, ...] }  (min 5)
export const addCodingCity = async (req, res) => {
  try {
    const data = await createCity(req.body || {});
    auditSafe({
      action: "create",
      description: `Added coding city "${data.city}" with ${data.created} rules.`,
      userID: req.user?.uid || null,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, "addCodingCity", error);
  }
};

// PUT /api/coding-rules/:id
// Body: { dayName, startTime, endTime, bannedDigits }
export const editCodingRule = async (req, res) => {
  try {
    const data = await updateRule(req.params.id, req.body || {});
    auditSafe({ action: "update", description: `Updated coding rule: ${describe(data)}.`, userID: req.user?.uid || null });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, "editCodingRule", error);
  }
};

// DELETE /api/coding-rules/:id
export const removeCodingRule = async (req, res) => {
  try {
    const removed = await deleteRule(req.params.id);
    auditSafe({ action: "delete", description: `Deleted coding rule: ${describe(removed)}.`, userID: req.user?.uid || null });
    return res.status(200).json({ success: true, data: removed });
  } catch (error) {
    return fail(res, "removeCodingRule", error);
  }
};

// DELETE /api/coding-rules/city/:city
// Removes the city and every coding rule it has. Owner / Admin only (route).
export const removeCodingCity = async (req, res) => {
  try {
    const data = await deleteCity(req.params.city);
    auditSafe({
      action: "delete",
      description: `Deleted coding city "${data.city}" and its ${data.deleted} rule${data.deleted === 1 ? "" : "s"}.`,
      userID: req.user?.uid || null,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, "removeCodingCity", error);
  }
};