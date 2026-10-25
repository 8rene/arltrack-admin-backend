// carPartTypes/{carPartTypeID}
// The catalog of part names a car can have (left mirror, bumper, ...). The admin only READS it:
//   - listCarPartTypes() in services/carParts/carParts.service.js (the part picker)
//   - resolvePartFieldKeys() in services/vehicleDocumentation/vehicleDocumentation.service.js, which turns the name into the
//     photo field key (camelCase + "Url", e.g. "leftMirrorUrl")
// The document ID is the carPartTypeID; carParts.carPartTypeID points to it. The ID is not stored as a field.
export const CarPartType = {
  carPartName: "",   // display name; readers fall back to the doc ID when it is missing
};
