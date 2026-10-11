// ─────────────────────────────────────────────
// vehicleInspectionArchives collection schema
//
// ONE document per booking (doc id = bookingID) holding the booking's four live inspection collections as exact
// copies. Unlike the other archives (one archive doc per live doc) the four collections are kept together because
// they are always viewed, restored and deleted as one set. Photo URLs inside the records keep pointing at Firebase
// Storage: the files are never moved, and are deleted only by a permanent delete.
// ─────────────────────────────────────────────
export const VehicleInspectionArchive = {
  vehicleInspectionArchivesId: "", // = bookingID
  originalId: "",                  // = bookingID
  bookingID: "",                   // links to bookingArchives / bookings
  carID: null,                     // from the first record that has one (used by the archive page)
  records: [],                     // [{ collection, id, data }] -- see the four shapes below
  // archive bookkeeping (archiveMeta.js)
  archiveDate: null,
  archivedAt: null,
  archivedBy: "",
};

// records[].collection is one of these four; records[].id is the live doc id (put back under it on restore);
// records[].data is the whole live document, with the columns below.
export const ArchivedInspectionRecords = {
  // part condition: one per trip phase
  inventoryBeforeTrip: {
    inventoryBeforeTripID: "",
    bookingID: "",
    carID: "",
    inventoryOverallStatus: "",   // "good" | "has damage"
    damageParts: [],              // [{ carPartID, carPartName, serialNumber, status }]
    recordedAt: null,
  },
  inventoryAfterTrip: {
    inventoryAfterTripID: "",
    bookingID: "",
    carID: "",
    inventoryOverallStatus: "",
    damageParts: [],
    recordedAt: null,
  },
  // photos: required front/side/back + one dynamic <partName>Url per car part (e.g. leftMirrorUrl)
  vehicleDocumentationBeforeTrip: {
    vehicleDocumentationBeforeTripID: "",
    bookingID: "",
    carID: "",
    frontViewUrl: "",             // Firebase Storage URL
    sideViewUrl: "",
    backViewUrl: "",
    // [dynamic part fields]      // e.g. leftMirrorUrl, rightHeadlightUrl, ...
    createdAt: null,
    updatedAt: null,
  },
  vehicleDocumentationAfterTrip: {
    vehicleDocumentationAfterTripID: "",
    bookingID: "",
    carID: "",
    frontViewUrl: "",
    sideViewUrl: "",
    backViewUrl: "",
    // [dynamic part fields]
    createdAt: null,
    updatedAt: null,
  },
};