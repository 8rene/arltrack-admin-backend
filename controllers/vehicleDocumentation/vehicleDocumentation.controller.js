import {
  getVehicleDocsByBooking,
  saveVehicleDocBefore,
  saveVehicleDocAfter,
  saveInventoryStatus,
  adminReplaceHistoryPhoto,
} from "../../services/vehicleDocumentation/vehicleDocumentation.service.js";
import { db } from "../../config/firebaseConnection/firebase.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

// PATCH /api/vehicle-docs/history/:tripPhase/:bookingID — Admin-only,
// points a photo field at a freshly-uploaded URL. The upload itself
// happens client-side straight to Storage (same as the driver flow) —
// this just records where it landed. See adminReplaceHistoryPhoto.
export const editHistoryPhoto = async (req, res) => {
  try {
    const { tripPhase, bookingID } = req.params;
    const { carID, fieldKey, newUrl } = req.body;
    if (!fieldKey || !newUrl) {
      return res.status(400).json({ success: false, message: "fieldKey and newUrl are required." });
    }
    const result = await adminReplaceHistoryPhoto({
      tripPhase, bookingID, carID, fieldKey, newUrl,
      editedBy: req.user?.uid || req.user?.userID || null,
    });
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE DOCS] editHistoryPhoto error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Drivers get their own routes below (vehicleDocumentation.routes.js), but
// unlike Owner/Admin/Supervisor — who manage every car's documentation —
// a Driver may only touch documentation for a booking assigned to THEM.
// That's enforced here per-request rather than trusting the frontend to
// only ever navigate them to their own bookings.
const assertOwnershipIfDriver = async (req, bookingID) => {
  if (req.user?.role !== "Driver") return; // staff roles: unrestricted
  const doc = await db.collection("bookings").doc(bookingID).get();
  if (!doc.exists || doc.data().driverID !== req.user.uid) {
    const err = new Error("This booking's documentation is not accessible to you.");
    err.status = 403;
    throw err;
  }
};

// ─────────────────────────────────────────────
// GET /api/vehicle-docs/booking/:bookingID
// Returns { before, after } documentation records for a booking
// ─────────────────────────────────────────────
export const getVehicleDocs = async (req, res) => {
  try {
    const { bookingID } = req.params;
    if (!bookingID)
      return res.status(400).json({ success: false, message: "bookingID is required." });

    await assertOwnershipIfDriver(req, bookingID);

    const data = await getVehicleDocsByBooking(bookingID);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[VEHICLE_DOCS] getVehicleDocs error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
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

    await assertOwnershipIfDriver(req, bookingID);

    const result = await saveVehicleDocBefore({ bookingID, carID, photoFields });

    createAuditLog({
      action: "update",
      description: `Saved before-trip photo(s) for booking ${bookingID}: ${Object.keys(photoFields).join(", ")}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[VEHICLE_DOCS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE_DOCS] saveBeforeTrip error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
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

    await assertOwnershipIfDriver(req, bookingID);

    const result = await saveVehicleDocAfter({ bookingID, carID, photoFields });

    createAuditLog({
      action: "update",
      description: `Saved after-trip photo(s) for booking ${bookingID}: ${Object.keys(photoFields).join(", ")}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[VEHICLE_DOCS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE_DOCS] saveAfterTrip error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// PUT /api/vehicle-docs/inventory-status
// Body: { bookingID, carID, tripType: "before"|"after", overallStatus, damageParts }
// Upserts inventoryBeforeTrip/inventoryAfterTrip — the Good/Damaged part
// flags, separate from the photo docs above. Was previously written
// directly from the browser (VehicleDocs.jsx's commitStatusEdits) with no
// role check, driver-ownership check, or audit trail.
// ─────────────────────────────────────────────
export const saveInventoryStatusHandler = async (req, res) => {
  try {
    const { bookingID, carID, tripType, overallStatus, damageParts } = req.body;

    if (!bookingID || !carID)
      return res.status(400).json({ success: false, message: "bookingID and carID are required." });
    if (tripType !== "before" && tripType !== "after")
      return res.status(400).json({ success: false, message: "tripType must be 'before' or 'after'." });

    await assertOwnershipIfDriver(req, bookingID);

    const result = await saveInventoryStatus({ bookingID, carID, tripType, overallStatus, damageParts });

    createAuditLog({
      action: "update",
      description: `Updated ${tripType}-trip part status for booking ${bookingID} (${overallStatus || "unknown"}).`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[VEHICLE_DOCS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    console.error("[VEHICLE_DOCS] saveInventoryStatus error:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};