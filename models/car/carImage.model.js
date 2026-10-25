// carImages/{imageID}
// The car's picture. Written by setPrimaryCarImage() in services/fleet/fleet.service.js: if the car already has a primary
// image only imageURL is replaced, otherwise a new document is added. The document ID is not stored as a field.
export const CarImage = {
  carID: "",         // FK to cars/{carID}
  imageURL: "",
  isPrimary: true,   // always true for what the admin writes
  label: "",         // "Primary"
  createdAt: null,   // only set when the document is first created
};
