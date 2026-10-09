// Bookkeeping fields an archive document carries that never belong on the live document.
// Restoring spreads the archive back into its live collection, so strip these first -- otherwise
// paymentsArchivesID / archiveDate / ... end up on a live payment, booking or refund request.
// Both spellings of each archive ID are listed: older docs used a lowercase "d" (...ArchivesId).
export const ARCHIVE_META_KEYS = [
  "paymentsArchivesID", "paymentsArchivesId",
  "bookingArchivesID",  "bookingArchivesId",
  "refundArchivesID",   "refundArchivesId",
  "originalId",
  "archiveDate", "archivedAt", "archivedBy",
  "restoredAt", "restoredBy",
  "customerName",   // resolved when the archive page is read; not part of the live schema
];

/** A copy of an archive document's data without the bookkeeping fields. */
export const stripArchiveMeta = (data = {}) => {
  const out = { ...data };
  for (const k of ARCHIVE_META_KEYS) delete out[k];
  return out;
};