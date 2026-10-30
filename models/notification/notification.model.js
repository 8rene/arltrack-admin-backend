// notifications/{id}
//
// Single, consistent shape for every admin-facing notification. Replaces
// the old pattern of querying live "bookings"/"carParts" collections
// directly and treating the results as fake notifications — every real
// alert is now an actual doc here.
//
// refID + refCollection together are what make a notification clickable
// to the EXACT record (not just the page) — see components/Header.jsx's
// click handler and each page's `?open=` param reader.
//
// userID: who this specific copy belongs to. Types that need to reach
// more than one person (e.g. cancellation_request going to every
// Owner/Admin/Supervisor) write one doc PER PERSON, each with their own
// userID — so isRead/dismiss is personal to that person, not shared.
// resolveNotification() already matches by type+refID with no userID
// filter, so approving/rejecting the underlying event clears every
// fan-out copy at once, for free.
export const Notification = {
  type: "",
  //   Staff-facing (fan-out to Owner/Admin/Supervisor, or Owners only):
  //   "cancellation_request" | "new_user" | "geofence_alert" | "coding_alert" |
  //   "pickup_overdue" | "return_overdue" | "refund_due" | "refund_request" | "license_expiring" |
  //   "license_expired" | "inspection_pickup_needed" | "inspection_return_needed" | "id_resubmit_request" |
  //   "discount_applied" | "penalty_created" | "penalty_review" | "maintenance_created" | "booking_cancelled"
  //   Customer / driver-facing (one doc for that person):
  //   "terms_updated" | "inspection_confirmed" | "discount_applied" | "discount_edited" |
  //   "account_flagged" | "account_unflagged" |   (staff flagged / un-flagged this customer; refCollection "user", refID = the customer;
  //                                                see updateUserStatus in controllers/user/user.controller.js)
  //   "refund_approved" | "refund_rejected" | "refund_failed" | "refund_completed" |
  //   "deposit_return_processing" | "booking_cancelled" |
  //   "PenaltyConfirmed" | "PenaltyWaived" | "PenaltyVoided"   (penalty customer notices keep their old PascalCase names)
  //   Driver / customer / staff trip notices added to this list:
  //   "driver_assigned" | "driver_unassigned" | "driver_en_route" | "balance_reminder" | "maintenance_overdue"
  //   Written by the CUSTOMER backend (shares this collection):
  //     to staff:    "new_booking" | "edit_request" | "penalty_paid" | "payment_after_cancellation" | "id_resubmit_request" |
  //                  "cancellation_request" | "new_user" | "refund_request"
  //     to a driver: "driver_trip_reminder"
  //     to the customer: "payment_successful" | "payment_failed" | "booking_confirmed" | "upcoming_booking" |
  //                  "booking_reminder" | "booking_expired" | "booking_cancelled"
  //   (type values are snake_case by convention; only the penalty notices above are PascalCase)
  //   (booking_cancelled: one to the assigned driver, and one to every other Owner/Admin/Supervisor when an admin
  //   cancels a booking; see services/refundRequest/refundRequest.service.js)
  //   (refund_failed / refund_completed: the customer's security deposit and/or discount credit return was delayed /
  //   handed back in store; refund_due is the STAFF follow-up for the same payout; see
  //   services/depositReturn/depositReturn.service.js)
  //   (terms_updated: sent to EVERY account in `user` whenever a new Terms &
  //   Conditions version is published — refCollection "terms", refID is the
  //   new termsVersionID, `version` is stored alongside; see notifyAllUsers()
  //   in services/notification/notification.service.js)
  //   (inspection_pickup_needed / inspection_return_needed: a driver hit "Remind Staff" — extra fields carID,
  //   phase and bookingKey are stored alongside, see
  //   services/inspectionReminders/inspectionReminders.service.js)
  //   (inspection_confirmed: staff finished a before / after inspection; goes to the booking's driver, or to the
  //   customer when no driver is assigned. carID and phase are stored alongside and phase is also the dedupeKey)

  userID: "",            // which staff account this specific copy belongs to
  refID: "",              // doc ID of the record this notification is about
  refCollection: "",      // which collection refID lives in: "bookings" | "user" | "cars" | "terms" |
                          // "penalties" | "maintenance"

  title: "",
  message: "",

  // ---- optional fields: only some notification types carry them (passed as `extra` / `dedupeKey` to
  //      createNotification() in services/notification/notification.service.js; absent on every other type) ----
  dedupeKey: null,        // makes events that share one refID separate notifications. Without it createNotification() treats an
                          // active doc with the same type + refID + userID as a duplicate and drops the new one. With it, only a doc
                          // carrying the SAME key counts as a duplicate (checked in memory, so no extra Firestore index). Values used:
                          //   inspection_confirmed:   the phase ("before" | "after")
                          //   refund_failed:          "payout_delayed:<bookingID>"
                          //   refund_completed:       "in_store:<bookingID>:<d|c|dc>"  (d = deposit, c = discount credit)
                          //   PenaltyConfirmed / PenaltyWaived / PenaltyVoided: the penaltyID (refID is the booking)
  carID: null,            // inspection_pickup_needed, inspection_return_needed, inspection_confirmed, maintenance_created:
                          // lets the bell open that car's page
  phase: null,            // inspection_*: "before" | "after"
  bookingKey: null,       // inspection_pickup_needed / inspection_return_needed: the booking's key, used to resolve the reminder
                          // once staff finish the inspection
  version: null,          // terms_updated: the Terms & Conditions version number

  isRead: false,
  status: "active",      // "active" | "resolved" — auto-resolved notifications
                          // (geofence/coding/overdue) get cleared automatically
                          // when the underlying condition clears; the manually
                          // dismissable ones (cancellation_request, new_user)
                          // just get deleted on click-to-dismiss.

  createdAt: null,
  resolvedAt: null,
};