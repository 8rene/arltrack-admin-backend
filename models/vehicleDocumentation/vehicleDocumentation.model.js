// ─────────────────────────────────────────────
// vehicleDocumentationBeforeTrip collection schema
//
// Dynamic part fields are NOT listed here — they are built at runtime
// from the car's inventory parts (carParts collection).
// Each part name is converted to camelCase + "Url" suffix:
//   e.g. "Left Mirror" → leftMirrorUrl
// ─────────────────────────────────────────────
export const VehicleDocumentationBeforeTrip = {
  vehicleDocumentationBeforeTripID: "", // Firestore doc ID (auto-set after creation)
  bookingID: "",                        // links to bookings collection
  carID: "",
  frontViewUrl:  "",                    // required
  sideViewUrl:   "",                    // required
  backViewUrl:   "",                    // required
  // [dynamic part fields]              // e.g. leftMirrorUrl, rightHeadlightUrl, …
  createdAt: null,
  updatedAt: null,
};

// ─────────────────────────────────────────────
// vehicleDocumentationAfterTrip collection schema
// ─────────────────────────────────────────────
export const VehicleDocumentationAfterTrip = {
  vehicleDocumentationAfterTripID: "", // Firestore doc ID (auto-set after creation)
  bookingID: "",                       // same bookingID as the before-trip record
  carID: "",
  frontViewUrl:  "",                   // required
  sideViewUrl:   "",                   // required
  backViewUrl:   "",                   // required
  // [dynamic part fields]             // e.g. leftMirrorUrl, rightHeadlightUrl, …
  createdAt: null,
  updatedAt: null,
};

// ─────────────────────────────────────────────
// Helper: convert a part name string to its URL field key
//   "Left Mirror"      → "leftMirrorUrl"
//   "Right Headlight"  → "rightHeadlightUrl"
//   "Front Bumper"     → "frontBumperUrl"
// ─────────────────────────────────────────────
export const partNameToFieldKey = (partName = "") => {
  const camel = partName
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .map((word, i) =>
      i === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("");
  return camel ? `${camel}Url` : "";
};
