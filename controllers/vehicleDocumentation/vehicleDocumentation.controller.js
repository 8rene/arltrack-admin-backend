import {
  getVehicleDocsByBooking,
  saveVehicleDocBefore,
  saveVehicleDocAfter,
} from "../../services/vehicleDocumentation/vehicleDocumentation.service.js";

// ─────────────────────────────────────────────
// GET /api/vehicle-docs/booking/:bookingID
// Returns { before, after } documentation records for a booking
// ─────────────────────────────────────────────
export const getVehicleDocs = async (req, res) => {
  try {
    const { bookingID } = req.params;
    if (!bookingID)
      return res.status(400).json({ success: false, message: "bookingID is required." });

    const data = await getVehicleDocsByBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[VEHICLE_DOCS] getVehicleDocs error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/vehicle-docs/before-trip
// Body: {
//   bookingID: string,
//   carID: string,
//   photoFields: {
//     frontViewUrl?: string,
//     sideViewUrl?: string,
//     backViewUrl?: string,
//     [partFieldKey]?: string,   // e.g. leftMirrorUrl, rightHeadlightUrl
//   }
// }
// Upserts vehicleDocumentationBeforeTrip document.
// ─────────────────────────────────────────────
export const saveBeforeTrip = async (req, res) => {
  try {
    const { bookingID, carID, photoFields } = req.body;

    if (!bookingID || !carID)
      return res.status(400).json({ success: false, message: "bookingID and carID are required." });

    if (!photoFields || typeof photoFields !== "object")
      return res.status(400).json({ success: false, message: "photoFields object is required." });

    const result = await saveVehicleDocBefore({ bookingID, carID, photoFields });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE_DOCS] saveBeforeTrip error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/vehicle-docs/after-trip
// Body: { bookingID, carID, photoFields }
// Upserts vehicleDocumentationAfterTrip document.
// ─────────────────────────────────────────────
export const saveAfterTrip = async (req, res) => {
  try {
    const { bookingID, carID, photoFields } = req.body;

    if (!bookingID || !carID)
      return res.status(400).json({ success: false, message: "bookingID and carID are required." });

    if (!photoFields || typeof photoFields !== "object")
      return res.status(400).json({ success: false, message: "photoFields object is required." });

    const result = await saveVehicleDocAfter({ bookingID, carID, photoFields });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE_DOCS] saveAfterTrip error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
