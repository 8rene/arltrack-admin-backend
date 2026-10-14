// ─────────────────────────────────────────────
// carParts collection schema
// ─────────────────────────────────────────────
// The parts catalog of each vehicle (Inventory page). Documentation only —
// nothing reads this object at runtime; carParts.service.js writes the documents,
// the same way models/inventory and models/maintenance work.
//
// The part's PRICE is not stored here — it lives in its own collection, one
// document per part (models/carPartPricing).
export const CarPart = {
  carPartID: "",        // Firestore doc ID
  carID: "",            // FK -> cars
  carPartName: "",
  carPartTypeID: "",    // FK -> carPartTypes
  serialNumber: "",     // optional

  // The part's LIVE condition: "Good" | "Damaged" | "Stolen" | "Missing". New parts start "Good".
  // Never typed in by hand and never edited step by step — it is RECOMPUTED from the real sources
  // (the car's latest inspection, minus parts a Completed maintenance job has fixed) after every
  // inspection save / edit / delete / restore and every maintenance change. A value set by hand is
  // overwritten the next time that car syncs. The rule lives in
  // services/carParts/carPartConditions.service.js (the frontend's utils/damagedParts.js mirrors it).
  // Older documents may still hold "Replaced" — it reads as "Good" and is overwritten on the next sync.
  status: "Good",

  // Left over from the retired "mark replaced" route. No longer written; harmless if present.
  // replacedAt: Timestamp, replacedType: "damaged" | "stolen" | "missing"
};