import {
  getDispatchBoard, assignDriver, unassignDriver, getDriverAvailabilityForBooking,
  getMyTrips, getMyTripHistory, driverPickup, driverDropoff, driverRemindInspection,
  driverCreatePenalty,
} from "../../services/driverDispatch/driverDispatch.service.js";

export const getBoard = async (req, res) => {
  try {
    const data = await getDispatchBoard();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[DRIVER DISPATCH] board error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const assign = async (req, res) => {
  try {
    // overrideReason: required (with force) when the driver's trips truly overlap; stored in the audit log.
    const { bookingID, driverID, force, overrideReason } = req.body;
    const assignedBy = req.user?.username || req.user?.uid || "admin";
    const editedBy = req.user?.uid || req.user?.userID || null;
    const result = await assignDriver(bookingID, driverID, assignedBy, !!force, editedBy, overrideReason);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    // Conflicts (double-booking, expired license, etc.) are an expected
    // outcome the frontend branches on (warning + "assign anyway"), not a
    // real server error — warn instead of error so they don't get flagged
    // alongside actual bugs. Anything else here is still unexpected.
    if (error.conflict) console.warn("[DRIVER DISPATCH] assign conflict:", error.message);
    else console.error("[DRIVER DISPATCH] assign error:", error);
    const status = error.conflict ? 409 : 400;
    return res.status(status).json({
      success: false,
      message: error.message,
      conflict: !!error.conflict,
      conflictBooking: error.conflictBooking || null,
      conflictType: error.conflictType || null,         // "overlap" | "tight" | null
      requiresReason: !!error.requiresReason,           // true: resend with force + overrideReason
      licenseExpired: !!error.licenseExpired,
      bufferMinutes: error.bufferMinutes ?? null,
    });
  }
};

// GET /api/driver-dispatch/availability?bookingID=<doc id>
// Every driver as free / tight / busy for THAT booking, so the picker can show it before an admin clicks.
export const getAvailability = async (req, res) => {
  try {
    const data = await getDriverAvailabilityForBooking(req.query.bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[DRIVER DISPATCH] availability error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const unassign = async (req, res) => {
  try {
    const { bookingID } = req.body;
    const editedBy = req.user?.uid || req.user?.userID || null;
    const result = await unassignDriver(bookingID, editedBy);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] unassign error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// DRIVER SELF-SERVICE — req.user.uid is the acting driver, always. Never
// trust a driverID from the request body/params for these; that's the
// whole point of the ownership check living in the service layer.
// ─────────────────────────────────────────────

export const getMine = async (req, res) => {
  try {
    const data = await getMyTrips(req.user.uid);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-trips error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getMyHistory = async (req, res) => {
  try {
    const data = await getMyTripHistory(req.user.uid);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-history error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const myPickup = async (req, res) => {
  try {
    const result = await driverPickup(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-pickup error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

export const myDropoff = async (req, res) => {
  try {
    const result = await driverDropoff(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-dropoff error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};

// POST /api/driver-dispatch/my-trips/:id/remind-inspection  { phase: "before" | "after" }
// 429 (with retryAfterSeconds) while the 10-minute cooldown is still running.
export const myRemindInspection = async (req, res) => {
  try {
    const { phase } = req.body || {};
    const result = await driverRemindInspection(req.params.id, req.user.uid, phase);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error.status !== 429) console.error("[DRIVER DISPATCH] my-remind-inspection error:", error);
    return res.status(error.status || 400).json({
      success: false,
      message: error.message,
      ...(error.retryAfterSeconds != null ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    });
  }
};

export const myCreatePenalty = async (req, res) => {
  try {
    const result = await driverCreatePenalty(req.params.id, req.user.uid, req.body);
    if (result.error) return res.status(400).json({ success: false, message: result.error });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-create-penalty error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};