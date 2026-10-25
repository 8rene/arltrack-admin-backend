// model/{modelID}   (the Firestore collection is called "model"; this folder is carModel to avoid confusion with "models/")
// The document ID is the modelID: it is NOT stored as a field. Written by addModel() in services/fleet/fleet.service.js.
// Cars point to it with cars.modelID. deleteModel() refuses (409) while any car still uses the model.
export const CarModel = {
  modelName: "",   // trimmed before saving
  brandID: "",     // FK to brand/{brandID}
};
