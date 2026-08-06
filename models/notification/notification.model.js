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
export const Notification = {
  type: "",
  //   "cancellation_request" | "new_user" | "geofence_alert" |
  //   "coding_alert" | "pickup_overdue" | "return_overdue"

  refID: "",            // doc ID of the record this notification is about
  refCollection: "",     // which collection refID lives in: "bookings" | "user" | "cars"

  title: "",
  message: "",

  isRead: false,
  status: "active",      // "active" | "resolved" — auto-resolved notifications
                          // (geofence/coding/overdue) get cleared automatically
                          // when the underlying condition clears; the manually
                          // dismissable ones (cancellation_request, new_user)
                          // just get deleted on click-to-dismiss.

  createdAt: null,
  resolvedAt: null,
};