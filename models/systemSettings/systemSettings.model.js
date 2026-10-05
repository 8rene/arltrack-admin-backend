// ─────────────────────────────────────────────
// systemSettings/{systemSettingsID} — Firestore collection
// ─────────────────────────────────────────────
// One combined doc shape — NOT split by a "type" field. Every save writes
// a full snapshot of every settings area onto this same doc shape (pricing
// and store location today; other areas would add their own fields onto
// this same shape later rather than creating a separate kind of doc).
// Follows the same append-only convention as the rest of the app (e.g.
// carMaintenance): every save adds a NEW auto-ID doc rather than mutating
// one fixed doc, with the ID mirrored onto itself as systemSettingsID and
// a createdAt server timestamp. The "current" settings are just the most
// recently created doc. This model file just documents the shape —
// systemSettings.service.js is what actually reads/writes it.
//
// NOTE: the customer backend IS wired to this doc. utils/pricing.js reads
// the newest systemSettings doc (cached ~30s) and merges it over built-in
// defaults (serviceFeePercent 5, gatewayFeePercent 5, securityDepositAmount
// 1000). The public GET /api/policy route (customer backend) also exposes
// securityDepositAmount + the two fee percents so the Terms pages stay in
// sync (cached ~60s). The 48h full-refund window is a code constant, not
// editable here. The legacy flat serviceFee/gatewayFee pesos are no longer
// read by pricing and are dropped from new snapshots.
//
// storeName/storeLat/storeLng: powers the customer app's "Pick up
// in-store" option (Booking.jsx / BookingDetails.jsx). UNLIKE pricing,
// this one IS wired up — see customer-backend/controllers/location/
// location.controller.js's getStoreLocation, which reads this same doc
// directly (same Firebase project, so no admin-backend round trip
// needed). storeLat/storeLng are null until an admin sets a location via
// the map picker on the Settings page; the customer app treats null as
// "in-store pickup not offered" rather than defaulting to some guess.

export const PricingSettings = {
  // Percentage fees (0-100). NOT flat pesos any more.
  serviceFeePercent: 5,  // % of the RENTAL FEE only (no extra/driver's fee, no security deposit)
  gatewayFeePercent: 5,  // % of the rest of the booking: rental + extra + driver's + service fee + security deposit

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

  // In-store pickup location, set via the map picker on Settings.jsx.
  storeName: "",   // display label shown to customers, e.g. "ARL Car Rental — Malolos Branch"
  storeLat: null,  // null = not configured yet; "Pick up in-store" is hidden until both are set
  storeLng: null,

  // Security deposit + late-fee penalty settings. securityDepositAmount
  // is the real refundable deposit (the old flat, never-actually-charged
  // "reservation deposit" concept has been removed), snapshotted onto
  // each booking's payment
  // doc at pickup so a later change here doesn't retroactively affect
  // bookings already in progress. lateFeeRatePerHour/lateFeeGraceMinutes
  // are likewise snapshotted onto each late-fee penalty at creation time.
  securityDepositAmount: 1000,
  lateFeeRatePerHour: 100,
  lateFeeGraceMinutes: 30,

  systemSettingsID: null,  // mirrors this doc's own Firestore ID
  createdAt: null,         // Firestore server timestamp
  updatedBy: null,         // { userID, name } of the staff member who saved this snapshot
};