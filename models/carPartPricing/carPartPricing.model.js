// ─────────────────────────────────────────────
// carPartPricing collection schema
// ─────────────────────────────────────────────
// One pricing document per car part (the cost to replace that part).
// Kept in its own collection — NOT as a field on carParts — so the
// price history/ownership can evolve without touching the parts catalog.
//
// Rule: at most ONE pricing doc per carPartID. The service enforces this
// by upserting (update the existing doc, or create it if none exists).
export const CarPartPricing = {
  carPartPricingID: "",   // Firestore doc ID
  carPartID: "",          // links to carParts collection
  price: 0,               // PHP, number >= 0
  createdAt: null,        // Firestore server timestamp
  updatedAt: null,        // Firestore server timestamp
};