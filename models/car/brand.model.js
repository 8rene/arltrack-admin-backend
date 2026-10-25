// brand/{brandID}
// The document ID is the brandID, and addBrand() in services/fleet/fleet.service.js ALSO stores it as a field (set right after the
// document is created), so brandID is the same value both ways.
// Cars point to it with cars.brandID.
// Deleting a brand (Fleet > Brands & Models) also deletes ALL of that brand's models in the same batch (deleteBrand), but only
// when no car uses the brand or any of its models; otherwise it is refused (409) and nothing is deleted.
export const Brand = {
  brandID: "",     // same as the document ID; written by addBrand() right after the add
  brandName: "",   // trimmed before saving
};