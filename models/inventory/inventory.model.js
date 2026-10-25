// ─────────────────────────────────────────────
// inventoryBeforeTrip collection schema
//
// The document ID is the Firestore doc ID only: it is NOT stored as a field on the document. Records are always looked up
// by bookingID or carID, never by their own ID.
// ─────────────────────────────────────────────
export const InventoryBeforeTrip = {
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
// Same as above: the document ID is the Firestore doc ID only, not a stored field.
// ─────────────────────────────────────────────
export const InventoryAfterTrip = {
  bookingID: "",                 // links to bookings collection — same booking as Before Trip
  carID: "",
  inventoryOverallStatus: "",    // "good" | "has damage"
  damageParts: [],               // same shape as inventoryBeforeTrip.damageParts
  recordedAt: null,
};
