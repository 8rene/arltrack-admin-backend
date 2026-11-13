// ─────────────────────────────────────────────
// inventoryBeforeTrip collection schema
//
// The document ID is Firestore's auto ID and it is also stored as a field (inventoryBeforeTripID / inventoryAfterTripID,
// same value). Records created before that field existed don't have it; read the document ID for those. Records are
// still looked up by bookingID or carID.
// ─────────────────────────────────────────────
export const InventoryBeforeTrip = {
  inventoryBeforeTripID: "",     // this document's own ID (same value as the document ID)
  bookingID: "",                 // links to bookings collection
  carID: "",
  inventoryOverallStatus: "",    // "good" | "has damage"
  // The checklist items that are not good. Items from the driver's submission are stored as sent:
  // [{ carPartID, carPartName, serialNumber, status }]. An item added by an admin edit holds only { carPartID, status }.
  damageParts: [],
  recordedAt: null,
};

// ─────────────────────────────────────────────
// inventoryAfterTrip collection schema
//
// Same as above: the document ID is also stored, as inventoryAfterTripID.
// ─────────────────────────────────────────────
export const InventoryAfterTrip = {
  inventoryAfterTripID: "",      // this document's own ID (same value as the document ID)
  bookingID: "",                 // links to bookings collection — same booking as Before Trip
  carID: "",
  inventoryOverallStatus: "",    // "good" | "has damage"
  damageParts: [],               // same shape as inventoryBeforeTrip.damageParts
  recordedAt: null,
};