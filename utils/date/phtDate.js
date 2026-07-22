// Ported from the test backend's helpers.js phtDateFromInstant — GPS
// hardware and server clocks are UTC, but archive day-docs need to be
// keyed by the Manila calendar date (UTC midnight = 8 AM PHT, so a naive
// toISOString() split would mislabel the first 8 hours of every PHT day
// as the previous day).
export const phtDateFromInstant = (dateOrIsoString = new Date()) => {
  const d = dateOrIsoString instanceof Date ? dateOrIsoString : new Date(dateOrIsoString);
  const phtMs = d.getTime() + 8 * 60 * 60 * 1000;
  return new Date(phtMs).toISOString().split("T")[0]; // "YYYY-MM-DD"
};
