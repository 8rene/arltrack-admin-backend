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

/**
 * Every PHT calendar date a session spans, inclusive, as "YYYY-MM-DD"
 * strings — used to know which Sheets date-tabs to read when compiling a
 * session's full trail (a rental can cross midnight, sometimes several
 * times). Falls back sanely if end is before/equal start (single-day trip).
 */
export const datesBetweenPHT = (start, end = new Date()) => {
  const startStr = phtDateFromInstant(start);
  const endStr = phtDateFromInstant(end);
  const dates = [];
  let cur = new Date(`${startStr}T00:00:00Z`);
  const last = new Date(`${endStr}T00:00:00Z`);
  if (last < cur) return [startStr];
  while (cur <= last) {
    dates.push(cur.toISOString().split("T")[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
};