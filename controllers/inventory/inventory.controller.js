import {
  getInventoryByBooking,
  saveBeforeTrip,
  saveAfterTrip,
  getNearestBookingForCar,
  adminUpdateHistoryPartStatus,
} from "../../services/inventory/inventory.service.js";

// PATCH /api/inventory/history/:tripPhase/:bookingID  — Admin-only direct
// edit of a past trip's part status. Upserts: creates the record if the
// driver never submitted one for this booking. See
// adminUpdateHistoryPartStatus for why this doesn't go through
// saveBeforeTrip/saveAfterTrip.
export const editHistoryPartStatus = async (req, res) => {
  try {
    const { tripPhase, bookingID } = req.params;
    const { carID, carPartID, newStatus } = req.body;
    if (!carPartID || !newStatus) {
      return res.status(400).json({ success: false, message: "carPartID and newStatus are required." });
    }
    const result = await adminUpdateHistoryPartStatus({
      tripPhase, bookingID, carID, carPartID, newStatus,
      editedBy: req.user?.uid || req.user?.userID || null,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[INVENTORY] editHistoryPartStatus error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// GET /api/inventory/booking/:bookingID
// Returns { before, after } inventory records for the given booking
export const getInventory = async (req, res) => {
  try {
    const { bookingID } = req.params;
    if (!bookingID) return res.status(400).json({ success: false, message: "bookingID is required." });
    const data = await getInventoryByBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[INVENTORY] getInventory error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/inventory/nearest-booking/:carID
// Returns the nearest upcoming booking for the given car
export const getNearestBooking = async (req, res) => {
  try {
    const { carID } = req.params;
    if (!carID) return res.status(400).json({ success: false, message: "carID is required." });
    const data = await getNearestBookingForCar(carID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[INVENTORY] getNearestBooking error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/inventory/before-trip
// Body: { bookingID, carID, parts: [{ carPartID, carPartName, serialNumber, status }] }
// Saves inventoryBeforeTrip. Sends RULE 1 notification if damage detected.
export const saveBefore = async (req, res) => {
  try {
    const { bookingID, carID, parts } = req.body;
    if (!bookingID || !carID || !Array.isArray(parts)) {
      return res.status(400).json({ success: false, message: "bookingID, carID, and parts[] are required." });
    }
    const result = await saveBeforeTrip({ bookingID, carID, parts });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[INVENTORY] saveBefore error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/inventory/after-trip
// Body: { bookingID, carID, userID, parts: [{ carPartID, carPartName, serialNumber, status }] }
// Saves inventoryAfterTrip. Sends RULE 2 notification per damaged/stolen part.
export const saveAfter = async (req, res) => {
  try {
    const { bookingID, carID, userID, parts } = req.body;
    if (!bookingID || !carID || !Array.isArray(parts)) {
      return res.status(400).json({ success: false, message: "bookingID, carID, and parts[] are required." });
    }
    const result = await saveAfterTrip({ bookingID, carID, parts, userID });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[INVENTORY] saveAfter error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};