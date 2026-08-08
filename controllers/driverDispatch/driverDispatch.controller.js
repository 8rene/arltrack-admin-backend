import {
  getDispatchBoard, assignDriver, unassignDriver,
  getMyTrips, getMyTripHistory, driverPickup, driverDropoff, driverReturn,
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
    const { bookingID, driverID, force } = req.body;
    const assignedBy = req.user?.username || req.user?.uid || "admin";
    const result = await assignDriver(bookingID, driverID, assignedBy, !!force);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] assign error:", error);
    // Conflicts are a distinct, expected case the frontend needs to branch
    // on (show a warning + "assign anyway" instead of a plain error toast).
    const status = error.conflict ? 409 : 400;
    return res.status(status).json({
      success: false,
      message: error.message,
      conflict: !!error.conflict,
      conflictBooking: error.conflictBooking || null,
    });
  }
};

export const unassign = async (req, res) => {
  try {
    const { bookingID } = req.body;
    const result = await unassignDriver(bookingID);
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

export const myReturn = async (req, res) => {
  try {
    const result = await driverReturn(req.params.id, req.user.uid);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[DRIVER DISPATCH] my-return error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message });
  }
};