import {
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  retraceHolidaysToYear,
} from "../../services/holidays/holidays.service.js";
import { auditSafe } from "../../services/auditLogs/auditLogs.service.js";

const fail = (res, tag, error) => {
  console.error(`[HOLIDAYS] ${tag} error:`, error);
  return res.status(error.statusCode || 500).json({ success: false, message: error.message });
};

// GET /api/holidays
export const getHolidays = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await listHolidays() });
  } catch (error) {
    return fail(res, "getHolidays", error);
  }
};

// POST /api/holidays   Body: { holidayName, holidayDate: "YYYY-MM-DD" }
export const addHoliday = async (req, res) => {
  try {
    const data = await createHoliday(req.body || {});
    auditSafe({
      action: "create",
      description: `Added holiday "${data.holidayName}" on ${data.holidayDate} (${data.holidayDay}).`,
      userID: req.user?.uid || null,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, "addHoliday", error);
  }
};

// PUT /api/holidays/:id   Body: { holidayName, holidayDate }
export const editHoliday = async (req, res) => {
  try {
    const data = await updateHoliday(req.params.id, req.body || {});
    auditSafe({
      action: "update",
      description: `Updated holiday "${data.holidayName}" — now ${data.holidayDate} (${data.holidayDay}).`,
      userID: req.user?.uid || null,
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return fail(res, "editHoliday", error);
  }
};

// DELETE /api/holidays/:id
export const removeHoliday = async (req, res) => {
  try {
    const removed = await deleteHoliday(req.params.id);
    auditSafe({
      action: "delete",
      description: `Deleted holiday "${removed.holidayName}" (${removed.holidayDate}).`,
      userID: req.user?.uid || null,
    });
    return res.status(200).json({ success: true, data: removed });
  } catch (error) {
    return fail(res, "removeHoliday", error);
  }
};

// POST /api/holidays/retrace   Body: { year }
export const retraceHolidays = async (req, res) => {
  try {
    const result = await retraceHolidaysToYear(req.body?.year);
    auditSafe({
      action: "update",
      description: `Retraced ${result.updated} holiday${result.updated === 1 ? "" : "s"} to ${req.body.year}.`,
      userID: req.user?.uid || null,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return fail(res, "retraceHolidays", error);
  }
};
