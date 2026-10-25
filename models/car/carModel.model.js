// model/{modelID}   (the Firestore collection is called "model"; this folder is carModel to avoid confusion with "models/")
// The document ID is the modelID, and addModel() in services/fleet/fleet.service.js ALSO stores it as a field (set right after the
// document is created), so modelID is the same value both ways.
// Cars point to it with cars.modelID. deleteModel() refuses (409) while any car still uses the model.
export const CarModel = {
  modelID: "",     // same as the document ID; written by addModel() right after the add
  modelName: "",   // trimmed before saving
  brandID: "",     // FK to brand/{brandID}
};