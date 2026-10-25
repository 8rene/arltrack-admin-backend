// brand/{brandID}
// The document ID is the brandID: it is NOT stored as a field. Written by addBrand() in services/fleet/fleet.service.js.
// Cars point to it with cars.brandID.
// Deleting a brand (Fleet > Brands & Models) also deletes ALL of that brand's models in the same batch (deleteBrand), but only
// when no car uses the brand or any of its models; otherwise it is refused (409) and nothing is deleted.
export const Brand = {
  brandName: "",   // trimmed before saving
};
