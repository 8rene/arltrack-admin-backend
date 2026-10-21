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
  videos: [],                           // optional — see INSPECTION_MEDIA below
  extraPhotos: [],                      // optional — free pictures, see INSPECTION_MEDIA below
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
  videos: [],                          // optional — see INSPECTION_MEDIA below
  extraPhotos: [],                     // optional — free pictures, see INSPECTION_MEDIA below
  createdAt: null,
  updatedAt: null,
};

// ─────────────────────────────────────────────
// Optional free-form media on both docs above.
//
//   videos:      [{ url }]
//   extraPhotos: [{ url, caption? }]   (caption is an optional label, max 60 chars)
//
// They sit beside the fixed front/side/back fields and the per-part fields,
// never instead of them: the three exterior photos stay required, videos and
// extra photos are always optional. uploadedAt is an ISO string (not a
// Firestore Timestamp) so it survives being copied into/out of the archive.
// Files are uploaded straight to Firebase Storage by the browser; the backend
// only ever receives the resulting URL (Vercel's request-body limit is far too
// small for video).
// ─────────────────────────────────────────────
export const INSPECTION_MEDIA = {
  videos:      { field: "videos",      max: 3,  label: "video" },
  extraPhotos: { field: "extraPhotos", max: 20, label: "additional photo" },
};
// Hard limits for a single video file — also enforce these in Storage rules.
export const MAX_VIDEO_BYTES = 250 * 1024 * 1024; // 250 MB
export const MAX_VIDEO_SECONDS = 180;             // 3 minutes
export const MAX_EXTRA_PHOTO_BYTES = 10 * 1024 * 1024; // 10 MB

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