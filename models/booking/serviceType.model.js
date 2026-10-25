// serviceType/{serviceTypeID}   -- the general kind of service/occasion a booking is for (what the customer picks on the booking form)
// This is NOT the drive mode: self-drive vs chauffeur is bookings.modeOfDriving. The customer can also type their own text
// ("Others"), in which case bookings.serviceTypeID is null and the typed text is kept in bookings.serviceType.
// No code in either backend writes this collection: both only READ it, so it is kept by hand (Firebase console).
//   admin: a booking's serviceTypeID is looked up here to show a readable label (resolveServiceType in
//          services/booking/booking.service.js)
//   customer: the booking form lists only the names (getServiceTypes); the Services page (getServices in
//          controllers/services/services.controller.js) also shows the cars listed under each service
// The document ID is the serviceTypeID; it is not stored as a field.
export const ServiceType = {
  serviceType: "",   // the service's name shown on screen. The field is named serviceType, NOT serviceTypeName or name.
  carID: [],         // OPTIONAL array of carIDs shown under this service on the customer Services page; not used for booking, and the admin does not use it
};
