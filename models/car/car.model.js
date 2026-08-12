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
  // Only meaningful when status === "Inactive". Captured via a small modal
  // in Fleet.jsx when a car is switched to Inactive — cleared (set back to
  // null) if the car is later switched to any other status.
  inactiveReason: null, // short reason, e.g. "Sold" | "Retired" | "Stolen/Lost" | "Other"
  createdAt: null,
  updatedAt: null,
};