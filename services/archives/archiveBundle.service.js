// One place that decides what "restore" and "permanent delete" mean when they are started from a single archive
// record (Payments, Penalty, Refund, Reviews, Booking-session or Maintenance archive page).
//
//   RESTORE  -> if the booking is still in bookingArchives, restore the WHOLE booking (booking, payment, payment
//               entries, all refunds, all penalties, reviews, session, driver assignments, cancellation requests,
//               maintenance). Restoring from any page therefore never leaves a half-restored booking.
//               If the booking archive is gone (booking already live, or purged) only that record comes back.
//
//   DELETE   -> if the booking is still in bookingArchives, delete the WHOLE archived booking and everything archived
//               with it (the same permanent delete as the Booking Archive page).
//               If the booking archive is gone, that record can be deleted on its own, together with the payment
//               entries that belong to it alone. Siblings are untouched.
//
// Transaction logs are never deleted by any of this.
import { db } from "../../config/firebaseConnection/firebase.js";
import { chunk } from "./linkedArchives.service.js";
import { restoreBookingArchive, deleteBookingArchive } from "./bookingArchives.service.js";
import { restorePaymentsArchive } from "./paymentsArchives.service.js";
import { restorePenaltyArchive } from "./penaltyArchives.service.js";
import { restoreRefundArchive } from "./refundArchives.service.js";
import { restoreReviewsArchive } from "./reviewsArchives.service.js";
import { restoreBookingSessionArchive } from "./bookingSessionArchives.service.js";
import { restoreMaintenanceArchive } from "./maintenanceArchives.service.js";
import { restoreInspectionArchive, inspectionFileUrls } from "./vehicleInspectionArchives.service.js";
import { deleteStorageFiles } from "../../utils/storage/storageFiles.js";

const DELETE_BATCH = 450;

// kind -> where the archive lives, how to restore it alone, and (for money rows) which entry key it owns
export const ARCHIVE_KINDS = {
  payments:    { collection: "paymentsArchives",       label: "payment",         restoreOne: restorePaymentsArchive,       entryField: "paymentID",   liveParent: "payments" },
  penalties:   { collection: "penaltyArchives",        label: "penalty",         restoreOne: restorePenaltyArchive,        entryField: "penaltyID",   liveParent: "penalties" },
  refunds:     { collection: "refundArchives",         label: "refund request",  restoreOne: restoreRefundArchive,         entryField: "refundReqID", liveParent: "refundRequests" },
  reviews:     { collection: "reviewsArchives",        label: "review",          restoreOne: restoreReviewsArchive },
  sessions:    { collection: "bookingSessionArchives", label: "booking session", restoreOne: restoreBookingSessionArchive,
                 files: (snap) => [snap.data().archiveUrl].filter(Boolean) },   // the GPS history JSON in Storage
  inspection:  { collection: "vehicleInspectionArchives", label: "vehicle inspection", restoreOne: restoreInspectionArchive,
                 files: (snap) => [...inspectionFileUrls({ archiveSnaps: [snap] })] }, // the photos in Storage
  maintenance: { collection: "maintenanceArchives",    label: "maintenance record", restoreOne: restoreMaintenanceArchive },
};

// The booking archive of a booking, if it is still there (found by the booking's own id).
export const findBookingArchive = async (bookingID) => {
  if (!bookingID) return null;
  const snap = await db.collection("bookingArchives").where("bookingID", "==", bookingID).limit(1).get();
  return snap.empty ? null : snap.docs[0];
};

const loadArchive = async (kind) => {
  const cfg = ARCHIVE_KINDS[kind];
  if (!cfg) throw new Error(`Unknown archive kind: ${kind}`);
  return cfg;
};

const deleteRefs = async (refs) => {
  for (const part of chunk(refs, DELETE_BATCH)) {
    const batch = db.batch();
    part.forEach((r) => batch.delete(r));
    await batch.commit();
  }
};

// ── RESTORE ──────────────────────────────────────────────────────────────────
export const restoreArchiveItem = async (kind, archiveID, restoredBy = "admin") => {
  const cfg = await loadArchive(kind);
  const ref = db.collection(cfg.collection).doc(archiveID);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Archived ${cfg.label} not found.`);

  const bookingArchive = await findBookingArchive(snap.data().bookingID);

  if (bookingArchive) {
    const bundle = await restoreBookingArchive(bookingArchive.id, restoredBy);
    // Safety net: if the record was filed under a different key than the booking lookup used, bring it back by itself.
    if ((await ref.get()).exists) await cfg.restoreOne(archiveID, restoredBy);
    return { scope: "booking", bundle };
  }

  const single = await cfg.restoreOne(archiveID, restoredBy);
  return { scope: "single", single };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────────
// Payment entries that belong to this one record, in the archive and (only when the live parent is gone) live.
const ownEntryRefs = async (cfg, data, archiveID) => {
  if (!cfg.entryField) return [];
  const key = data[cfg.entryField] || (cfg.entryField === "refundReqID" ? data.refundRequestID : null) || data.originalId || archiveID;
  if (!key) return [];
  const keep = (row) => {
    // a payment owns only its deposit / balance rows: penalty and refund rows belong to the penalty / refund
    if (cfg.entryField === "paymentID") return !row.penaltyID && !row.refundReqID;
    return true;
  };
  const refs = [];
  const archived = await db.collection("paymentEntryArchives").where(cfg.entryField, "==", key).get();
  archived.docs.filter((d) => keep(d.data())).forEach((d) => refs.push(d.ref));

  const liveParent = await db.collection(cfg.liveParent).doc(String(data.originalId || key)).get();
  if (!liveParent.exists) {
    const live = await db.collection("paymentEntries").where(cfg.entryField, "==", key).get();
    live.docs.filter((d) => keep(d.data())).forEach((d) => refs.push(d.ref));
  }
  return refs;
};

export const deleteArchiveItem = async (kind, archiveID) => {
  const cfg = await loadArchive(kind);
  const ref = db.collection(cfg.collection).doc(archiveID);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`Archived ${cfg.label} not found.`);
  const data = snap.data();

  const bookingArchive = await findBookingArchive(data.bookingID);
  if (bookingArchive) {
    const bundle = await deleteBookingArchive(bookingArchive.id);
    if ((await ref.get()).exists) await ref.delete();
    return { scope: "booking", bundle };
  }

  const entryRefs = await ownEntryRefs(cfg, data, archiveID);
  const fileUrls = cfg.files ? cfg.files(snap) : [];
  await deleteRefs([...entryRefs, ref]);
  // files last: only after the record that could still have been restored is gone
  const files = fileUrls.length ? await deleteStorageFiles(fileUrls) : { deleted: 0, failed: 0 };
  return { scope: "single", deletedEntries: entryRefs.length, deletedFiles: files.deleted, failedFiles: files.failed };
};

// ── messages the controllers send back (the pages show them in their toasts) ──
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const restoreMessage = (kind, result) => {
  const label = ARCHIVE_KINDS[kind].label;
  if (result.scope !== "booking") {
    return `${cap(label)} restored. Its booking is not in the Booking Archive, so only this record (and its payment entries) came back.`;
  }
  const b = result.bundle || {};
  const parts = [
    b.restoredPayment && "payment",
    b.restoredPaymentEntries > 0 && plural(b.restoredPaymentEntries, "payment entry", "payment entries"),
    b.restoredRefunds > 0 && plural(b.restoredRefunds, "refund request", "refund requests"),
    b.restoredPenalties > 0 && plural(b.restoredPenalties, "penalty", "penalties"),
    b.restoredReviews > 0 && plural(b.restoredReviews, "review", "reviews"),
    b.restoredSession && "session",
    b.restoredDriverAssignments > 0 && plural(b.restoredDriverAssignments, "driver assignment", "driver assignments"),
    b.restoredCancellationRequests > 0 && plural(b.restoredCancellationRequests, "cancellation request", "cancellation requests"),
    b.restoredMaintenance > 0 && plural(b.restoredMaintenance, "maintenance record", "maintenance records"),
    b.restoredInspection > 0 && "vehicle inspection",
  ].filter(Boolean);
  return `The whole booking was restored (this ${label} is part of it)${parts.length ? `: ${parts.join(", ")}` : ""}.`;
};

export const deleteMessage = (kind, result) => {
  const label = ARCHIVE_KINDS[kind].label;
  if (result.scope !== "booking") {
    const n = result.deletedEntries || 0;
    const f = result.deletedFiles > 0 ? ` ${plural(result.deletedFiles, "stored file", "stored files")} removed from Storage.` : "";
    return `${cap(label)} permanently deleted${n ? ` with ${plural(n, "payment entry", "payment entries")} that belonged only to it` : ""}.${f} Its booking archive no longer exists, so nothing else was touched.`;
  }
  const d = result.bundle || {};
  const parts = [
    d.deletedPaymentArchive && "payment",
    d.deletedRefundArchives > 0 && plural(d.deletedRefundArchives, "refund request", "refund requests"),
    d.deletedPenaltyArchives > 0 && plural(d.deletedPenaltyArchives, "penalty", "penalties"),
    d.deletedReviewArchives > 0 && plural(d.deletedReviewArchives, "review", "reviews"),
    d.deletedSessionArchive && "session",
    d.deletedLinkedArchives > 0 && `${d.deletedLinkedArchives} entry / assignment / cancellation archive(s)`,
    d.deletedMaintenanceArchives > 0 && plural(d.deletedMaintenanceArchives, "maintenance record", "maintenance records"),
    (d.deletedInspectionArchives > 0 || d.deletedInspectionDocs > 0) && "vehicle inspection",
    d.deletedInspectionDocs > 0 && plural(d.deletedInspectionDocs, "inspection record", "inspection records"),
  ].filter(Boolean);
  const files = d.deletedFiles > 0 ? ` ${plural(d.deletedFiles, "stored file", "stored files")} (photos / GPS history) removed from Storage.` : "";
  return `The whole archived booking was permanently deleted (this ${label} is part of it)${parts.length ? `: ${parts.join(", ")}` : ""}.${files}`;
};