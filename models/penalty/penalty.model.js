// ─────────────────────────────────────────────────────────────
// penalties/{penaltyID}
//
// One document per chargeable line item against a booking's security
// deposit (late return, damaged/missing part, or a free-typed "other"
// charge). A booking can have many penalties — nothing here assumes one
// penalty per booking.
//
// Lifecycle:
//   Supervisor / Admin / Owner logs it:  Confirmed (customer notified at once) -> (optionally) Voided | Waived
//   Driver logs it:  UnderReview -> Confirmed (a supervisor confirms it, customer notified then) -> (optionally) Voided | Waived
//                                \-> Discarded (a supervisor rejects it during review; the customer is never told)
//
// UnderReview is the review step in front of Confirmed for penalties a Driver notes on a trip. While a penalty is
// UnderReview the customer knows nothing about it and it counts toward nothing: not the deposit math, not
// settlement, not receipts / statements, not the customer's outstanding balance (all of those only ever look at
// status === "Confirmed"). Supervisor / Admin / Owner can edit its line items (descriptions and amounts), add or
// remove items, and change the amount while it is UnderReview (editPenalty in penalty.service.js).
//
// The moment it is Confirmed the customer is notified and it is LOCKED: from then on corrections go through
// Voided/Waived + a new entry, never a silent edit to amount/lineItems. That is also why Void/Waive of a Confirmed
// penalty notifies the customer (see voidOrWaivePenalty) — they've already seen the charge once. Discarding an
// UnderReview penalty does NOT notify anyone: the customer never saw it. Discarded is its own status (it used to be
// Voided + discardedFromReview), so nothing that lists "removed" charges to the customer can pick it up by accident.
//
// PENALTY_TYPES / the single `type` + `description` fields are gone —
// replaced by `lineItems`, an array of { description, amount } typed
// freely when the penalty is charged (e.g. [{ description: "Cleaning", amount: 300 },
// { description: "Missing floor mat", amount: 200 }]). This is what the
// "manual input instead of a carPartID/inspectionID/maintenanceID FK"
// change landed as: a plain snapshot of what was true when the penalty
// was charged, not a live join back to those other collections. The
// penalty's own `amount` is the actually-charged total — normally the
// sum of lineItems' amounts, but can be overridden (see overrideReason).
// ─────────────────────────────────────────────────────────────

export const PENALTY_STATUSES = ["UnderReview", "Confirmed", "Voided", "Waived", "Discarded"];

// Written only by the review step, never by createPenalty, so they are listed here rather than in createPenaltyPayload
// (a new penalty must not carry empty columns). Present only on a penalty that went through UnderReview.
//   confirmedBy / confirmedAt   who confirmed it (and so notified the customer) and when. Penalties that were
//                               confirmed on creation don't store these: readers fall back to createdBy / createdAt.
//   editedBy / editedAt         who last edited it while it was UnderReview, and when.
//   discardedFromReview         LEGACY: true on penalties discarded before the Discarded status existed (they were saved as
//                               Voided). scripts/migrate-discarded-penalties.js turns those into status "Discarded".
export const PENALTY_REVIEW_FIELDS = ["confirmedBy", "confirmedAt", "editedBy", "editedAt", "discardedFromReview"];

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

  computedAmount: data.computedAmount ?? 0, // auto-calculated value, before any manual override
  amount:         data.amount         ?? 0, // amount actually charged (locked once created)
  overrideReason: data.overrideReason || "", // required once amount !== computedAmount

  // The online payment (gateway) fee % in System Settings when this penalty was created, saved like payments.gatewayFeeRate
  // so a later settings change can't alter what this penalty costs to pay online. It is charged ONLY if the customer pays it
  // through PayMongo (never in store or from the deposit), on what is still owed at that moment.
  // null = created before this existed: the current setting is used instead.
  gatewayFeeRate: data.gatewayFeeRate ?? null,
  // The online payment fee the customer has paid on this penalty so far, in pesos, ON TOP of paidAmount (which only ever
  // counts penalty money). Goes up each time the customer pays online, like paidAmount; 0 for in-store / deposit payments.
  // Written by the customer backend when an online penalty payment settles (penaltyPayment.util.js).
  gatewayFeePaid: data.gatewayFeePaid ?? 0,

  status:       data.status       || "Confirmed",
  statusReason: data.statusReason || "", // required for Voided / Waived / Discarded

  // paymentMethod / referenceNumber / paidAt are NOT stored on a penalty: each payment is a row in paymentEntries
  // (phase "penalty") and hydratePenalties() gives the latest method / reference / date back to readers. A
  // penalty covered by the held deposit stores nothing but paidAmount; settleBooking() records the offset on
  // payments.depositStatus / depositSettled / depositSettledAt.
  paidAmount:      data.paidAmount      ?? 0,  // may be < amount if partially covered by deposit

  // confirmedBy / confirmedAt are NOT stored on a new penalty confirmed on creation: they would always equal
  // createdBy / createdAt, so readers fall back to those. A penalty that went through UnderReview does get them
  // when it is confirmed (see PENALTY_REVIEW_FIELDS).
  createdBy:   data.createdBy   || null, // staff/driver uid who created it

  createdAt: data.createdAt || null,
  updatedAt: data.updatedAt || null,
});