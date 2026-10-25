// carPricing/{pricingID}
// One document per price tier of one car. Written by services/fleet/fleet.service.js (addCar, addPricingTier,
// updatePricingTier, replacePricingForCar). The document ID is the pricingID; it is not stored as a field.
export const CarPricing = {
  carID: "",          // FK to cars/{carID}
  durationType: "",   // free text label, e.g. "12 Hours" or "24 Hours". Tiers whose label contains "12" are listed LAST when shown.
  price: 0,           // number (saved with Number())
};
