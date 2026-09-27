// ─────────────────────────────────────────────────────────────
// penalties/{penaltyID}
//
// One document per chargeable line item against a booking's security
// deposit (late return, damaged/missing part, or a free-typed "other"
// charge). A booking can have many penalties — nothing here assumes one
// penalty per booking.
//
// Lifecycle: Draft -> Confirmed -> (optionally) Voided | Waived.
// Only Confirmed penalties count toward the deposit settlement math or
// are ever shown to the customer. Once Confirmed, a penalty is locked —
// corrections go through Voided/Waived + a new entry, never a silent
// edit to amount/lineItems after the fact (see updateDraftPenalty, which
// refuses once status !== "Draft").
//
// PENALTY_TYPES / the single `type` + `description` fields are gone —
// replaced by `lineItems`, an array of { description, amount } typed
// freely at draft time (e.g. [{ description: "Cleaning", amount: 300 },
// { description: "Missing floor mat", amount: 200 }]). This is what the
// "manual input instead of a carPartID/inspectionID/maintenanceID FK"
// change landed as: a plain snapshot of what was true when the penalty
// was charged, not a live join back to those other collections. The
// penalty's own `amount` is the actually-charged total — normally the
// sum of lineItems' amounts, but can be overridden (see overrideReason).
// ─────────────────────────────────────────────────────────────

export const PENALTY_STATUSES = ["Draft", "Confirmed", "Voided", "Waived"];

// How a confirmed penalty was actually settled once money changes hands.
// "Deposit" / "DepositPartial" are set automatically by settleBooking();
// the rest are set by whoever records the in-store or online payment.
export const PENALTY_PAYMENT_METHODS = [
  "Deposit",         // fully covered by the held deposit
  "DepositPartial",  // partially covered by the deposit, remainder recorded separately
  "InStore",         // supervisor collected cash in person
  "GCash",
  "Maya",
  "BankTransfer",
  "PayMongo",        // paid online through the same checkout rails as rental payments
];

export const createPenaltyPayload = (penaltyID, data = {}) => ({
  penaltyID,

  bookingID: data.bookingID || null, // FK -> bookings (owner of this penalty)
  paymentID: data.paymentID || null, // FK -> payments (denormalized, same as refundRequests)
  userID:    data.userID    || null, // FK -> user (customer being charged)
  carID:     data.carID     || null, // FK -> car (denormalized, for per-car reporting)

  lineItems: Array.isArray(data.lineItems) ? data.lineItems : [], // [{ description, amount }]

  // Late-fee specific — null for every other kind of penalty. This is
  // also how the code now tells a late-fee draft apart from any other
  // kind (see buildPenaltyID in penalty.service.js) now that there's no
  // `type` field to check against "Late".
  lateMinutes:    data.lateMinutes    ?? null,
  graceMinutes:   data.graceMinutes   ?? null, // system-settings snapshot at creation time
  rateAtCreation: data.rateAtCreation ?? null, // ₱/hour, system-settings snapshot

  computedAmount: data.computedAmount ?? 0, // auto-calculated value, before any manual override
  amount:         data.amount         ?? 0, // amount actually charged (editable while Draft)
  overrideReason: data.overrideReason || "", // required once amount !== computedAmount

  status:       data.status       || "Draft",
  statusReason: data.statusReason || "", // required for Voided / Waived

  paymentMethod:   data.paymentMethod   || "", // set once settled — see PENALTY_PAYMENT_METHODS
  referenceNumber: data.referenceNumber || "",
  paidAmount:      data.paidAmount      ?? 0,  // may be < amount if partially covered by deposit
  paidAt:          data.paidAt          || null,

  createdBy:   data.createdBy   || null, // staff/driver uid who drafted it
  confirmedBy: data.confirmedBy || null, // supervisor+ uid who confirmed it
  confirmedAt: data.confirmedAt || null,

  createdAt: data.createdAt || null,
  updatedAt: data.updatedAt || null,
});