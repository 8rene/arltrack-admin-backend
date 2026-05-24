// ─────────────────────────────────────────────
// inventoryBeforeTrip collection schema
// ─────────────────────────────────────────────
export const InventoryBeforeTrip = {
  inventoryBeforeTripID: "",     // Firestore doc ID
  bookingID: "",                 // links to bookings collection
  carID: "",
  inventoryOverallStatus: "",    // "good" | "has damage"
  damageParts: [],               // [{ carPartID, carPartName, serialNumber, status }]
  recordedAt: null,
};

// ─────────────────────────────────────────────
// inventoryAfterTrip collection schema
// ─────────────────────────────────────────────
export const InventoryAfterTrip = {
  inventoryAfterTripID: "",      // Firestore doc ID
  bookingID: "",                 // links to bookings collection — same booking as Before Trip
  carID: "",
  inventoryOverallStatus: "",    // "good" | "has damage"
  damageParts: [],               // [{ carPartID, carPartName, serialNumber, status }]
  recordedAt: null,
};
