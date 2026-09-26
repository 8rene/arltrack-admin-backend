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
// edit to amount/type after the fact (see updateDraftPenalty, which
// refuses once status !== "Draft").
// ─────────────────────────────────────────────────────────────

export const PENALTY_TYPES = [
  "Late",        // computed from returnedAt / customerDroppedOffAt vs. end time
  "Part",        // sourced from the booking's after-trip inspection
  "Cleaning",
  "Fuel",
  "Violation",
  "Smoking",
  "LostItem",
  "Other",
];

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

  type:        data.type        || "Other",
  description: data.description || "",

  // Late-fee specific — null for every other type.
  lateMinutes:    data.lateMinutes    ?? null,
  graceMinutes:   data.graceMinutes   ?? null, // system-settings snapshot at creation time
  rateAtCreation: data.rateAtCreation ?? null, // ₱/hour, system-settings snapshot

  // Part-damage specific — null for every other type.
  carPartID:    data.carPartID    || null, // FK -> carParts
  inspectionID: data.inspectionID || null, // FK -> vehicleDocumentation (the after-trip doc)

  // Optional link to a repair record filed for this same damage — set
  // later, independent of this penalty's own lifecycle. See
  // services/maintenance/maintenance.service.js for the other side.
  maintenanceID: data.maintenanceID || null,

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