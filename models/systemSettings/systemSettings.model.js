// ─────────────────────────────────────────────
// systemSettings/{systemSettingsID} — Firestore collection
// ─────────────────────────────────────────────
// One combined doc shape — NOT split by a "type" field. Every save writes
// a full snapshot of every settings area onto this same doc shape (only
// pricing exists today; other areas, e.g. maintenance, would add their own
// fields onto this same shape later rather than creating a separate kind
// of doc). Follows the same append-only convention as the rest of the app
// (e.g. carMaintenance): every save adds a NEW auto-ID doc rather than
// mutating one fixed doc, with the ID mirrored onto itself as
// systemSettingsID and a createdAt server timestamp. The "current"
// settings are just the most recently created doc. This model file just
// documents the shape — systemSettings.service.js is what actually
// reads/writes it.
//
// NOTE: as of this change, the customer backend still uses its own
// hardcoded constants — it has NOT been wired up to read from this doc
// yet. This is admin-side only: it gives Owner/Admin a place to change
// the numbers. Pointing customer-backend/utils/pricing.js at this same
// Firestore doc is a separate follow-up.

export const PricingSettings = {
  // Flat fees
  serviceFee: 50,      // flat platform/service fee
  gatewayFee: 53,      // flat payment gateway fee
  depositFee: 1000,    // reservation deposit

  // Out-of-area / chauffeur fees
  extraFeeOutsideArea: 500,     // added when destination is outside the base area
  driversFeeBaseArea: 1000,     // chauffeur fee, destination inside base area
  driversFeeOutsideArea: 1500,  // chauffeur fee, destination outside base area

  // What counts as "base area" (no extra fee). Destination string is
  // lower-cased and checked with .includes() against each keyword.
  baseAreaKeywords: ["manila", "bulacan"],

  // NOTE: the 22h/25h billing-block rule (how many hours = 1 billing day,
  // per duration type) is intentionally NOT here. It's not a price — it's
  // a unit definition the customer app's Booking.jsx date pickers already
  // hardcode separately (different calendar UI for "22 Hours" vs everything
  // else). Making it "adjustable" here without also rewriting that frontend
  // logic would just be a setting that silently does nothing. It stays a
  // hardcoded constant in customer-backend/utils/pricing.js.

  systemSettingsID: null,  // mirrors this doc's own Firestore ID
  createdAt: null,         // Firestore server timestamp
  updatedBy: null,         // { userID, name } of the staff member who saved this snapshot
};