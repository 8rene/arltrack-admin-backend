import { getDispatchBoard, assignDriver, unassignDriver } from "../../services/driverDispatch/driverDispatch.service.js";

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