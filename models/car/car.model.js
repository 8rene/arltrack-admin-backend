// Matches the actual 'cars' collection in Firestore
export const Car = {
  carID: "",
  modelID: "",        // references 'model' collection
  bodyType: "",       // e.g. "MPV", "SUV", "Sedan"
  color: "",
  fuelType: "",       // e.g. "Diesel", "Gasoline"
  plateNumber: "",
  seatingCapacity: 0,
  shortDescription: "",
  longDescription: "",
  transmission: "",   // "Automatic" | "Manual"
  year: 0,
  status: "",         // "Active" | "Inactive" | "Maintenance"
  createdAt: null,
  updatedAt: null,
};
