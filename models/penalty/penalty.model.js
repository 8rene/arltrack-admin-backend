// ─────────────────────────────────────────────────────────────
// penalties/{penaltyID}
//
// One document per chargeable line item against a booking's security
// deposit (late return, damaged/missing part, or a free-typed "other"
// charge). A booking can have many penalties — nothing here assumes one
// penalty per booking.
//
// Lifecycle: Confirmed -> (optionally) Voided | Waived.
//
// There used to be a Draft step in front of Confirmed — staff logged a
// charge, a supervisor reviewed it, only then did the customer hear
// about it. That's gone: every penalty is confirmed and the customer
// notified the moment it's created (see createPenalty in
// penalty.service.js). A penalty is locked from the moment it exists —
// corrections go through Voided/Waived + a new entry, never a silent
// edit to amount/lineItems after the fact. Void/Waive is now the only
// safety net for a mistake, which is why both notify the customer (see
// voidOrWaivePenalty) — by the time anyone can undo a charge, the
// customer's already seen it once.
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

export const PENALTY_STATUSES = ["Confirmed", "Voided", "Waived"];

// How a confirmed penalty was settled. This list is only the LABELS readers get back (hydratePenalty derives
// them); nothing here is stored on the penalty document.
//   "Deposit" / "DepositPartial"  covered by the held deposit (derived: no entry row and paidAmount > 0)
//   "InStore" / "GCash" / "Maya" / "BankTransfer"  the method of the latest penalty entry row
//   "PayMongo"                    the latest penalty entry row is an online one
//
// A penalty can be paid ONLINE by the customer (PayMongo checkout in the customer backend,
// penaltyPayment.controller.js) or in person (recordShortfallPayment): both write paymentEntries rows
// (phase "penalty", one row per penalty a payment covered). That is the only place the method, reference
// and date of a payment live. A payment covered by the held deposit has no row: no money moved, it is an
// offset recorded on the payment (its date is payments.depositSettledAt).
export const PENALTY_PAYMENT_METHODS = [
  "Deposit",         // fully covered by the held deposit
  "DepositPartial",  // partially covered by the deposit, remainder recorded separately
  "InStore",         // supervisor collected cash in person
  "GCash",
  "Maya",
  "BankTransfer",
];

// The methods staff can pick when they record an in-person payment (recordShortfallPayment). The two
// "Deposit..." values are set only by settleBooking().
export const PENALTY_SHORTFALL_METHODS = ["InStore", "GCash", "Maya", "BankTransfer"];

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

  status:       data.status       || "Confirmed",
  statusReason: data.statusReason || "", // required for Voided / Waived

  // paymentMethod / referenceNumber / paidAt are NOT stored on a penalty: each payment is a row in paymentEntries
  // (phase "penalty") and hydratePenalties() gives the latest method / reference / date back to readers. A
  // penalty covered by the held deposit stores nothing but paidAmount; settleBooking() records the offset on
  // payments.depositStatus / depositSettled / depositSettledAt.
  paidAmount:      data.paidAmount      ?? 0,  // may be < amount if partially covered by deposit

  // confirmedBy / confirmedAt are NOT stored on a new penalty: a penalty is confirmed the moment it is created,
  // so they were always equal to createdBy / createdAt. Readers fall back to those (older documents keep theirs).
  createdBy:   data.createdBy   || null, // staff/driver uid who created it

  createdAt: data.createdAt || null,
  updatedAt: data.updatedAt || null,
});