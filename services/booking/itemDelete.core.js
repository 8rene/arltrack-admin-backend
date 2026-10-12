// Delete a single PAYMENT or PENALTY from its own page (Owner / Admin only -- the route enforces that).
//
//   booking is live   -> the WHOLE booking goes with it (deleteBookingWithCascade: payment, refunds, penalties,
//                        reviews, session, entries, assignments, cancellations, maintenance). A payment or penalty
//                        never leaves its booking behind half-deleted.
//   booking is gone   -> nothing else exists to take along, so just this one record is archived (one atomic batch:
//                        archive copy + live delete). Its money rows (paymentEntries) stay where they are; the
//                        archive pages read them from there.
//
// "Delete" always means ARCHIVE here; permanent deletion only happens on the archive pages.
// `db`, `FieldValue` and the two booking functions are injected so this runs against a fake in tests.
import { evaluateGuards, DeleteBlockedError, mayForce } from "./deleteGuard.js";

const KINDS = {
  payment: { live: "payments",  archive: "paymentsArchives", archiveIdField: "paymentsArchivesID", ownIdField: "paymentID" },
  penalty: { live: "penalties", archive: "penaltyArchives",  archiveIdField: "penaltyArchivesId",  ownIdField: "penaltyID" },
};

export const makeItemDelete = ({ db, FieldValue, previewBooking, deleteBooking }) => {
  const load = async (kind, id) => {
    const snap = await db.collection(KINDS[kind].live).doc(id).get();
    if (!snap.exists) throw new Error(`${kind === "payment" ? "Payment" : "Penalty"} not found: ${id}`);
    return { ref: snap.ref, data: snap.data() };
  };

  /** The live booking this record belongs to, or null (hard-deleted, or already archived). */
  const findLiveBooking = async (bookingID) => {
    if (!bookingID) return null;
    const direct = await db.collection("bookings").doc(String(bookingID)).get();
    if (direct.exists) return { id: direct.id };
    const q = await db.collection("bookings").where("bookingID", "==", bookingID).limit(1).get();
    return q.empty ? null : { id: q.docs[0].id };
  };

  const aloneGuards = async (kind, id, data) => {
    if (kind === "penalty") return evaluateGuards({ penalties: [{ ...data, id }] });
    const refunds = (await db.collection("refundRequests").where("paymentID", "==", data.paymentID || id).get())
      .docs.map((d) => ({ ...d.data(), id: d.id }));
    return evaluateGuards({ payments: [data], refunds });
  };

  const previewItemDelete = async (kind, id) => {
    const item = await load(kind, id);
    const booking = await findLiveBooking(item.data.bookingID);
    if (booking) return { ...(await previewBooking(booking.id)), target: { kind, id } };
    const guards = await aloneGuards(kind, id, item.data);
    return {
      mode: "alone", target: { kind, id }, booking: null, counts: { [kind]: 1 }, ...guards,
      note: "Its booking no longer exists in the live bookings, so only this record is removed.",
    };
  };

  const deleteItem = async (kind, id, archivedBy = "admin", opts = {}) => {
    const item = await load(kind, id);
    const booking = await findLiveBooking(item.data.bookingID);
    if (booking) return deleteBooking(booking.id, archivedBy, opts);

    const guards = await aloneGuards(kind, id, item.data);
    if (guards.blockers.length && !mayForce(opts)) {
      throw new DeleteBlockedError(guards.blockers[0].message, { ...guards, canForce: Boolean(opts.canForce) });
    }
    const K = KINDS[kind];
    const archiveRef = db.collection(K.archive).doc();
    const batch = db.batch();
    batch.set(archiveRef, {
      [K.archiveIdField]: archiveRef.id,
      [K.ownIdField]: item.data[K.ownIdField] ?? id,
      originalId: id,
      archiveDate: FieldValue.serverTimestamp(),
      archivedAt: FieldValue.serverTimestamp(),
      archivedBy,
      ...item.data,
    });
    batch.delete(item.ref);
    await batch.commit();
    return {
      success: true, mode: "alone", kind, archiveID: archiveRef.id, bookingID: item.data.bookingID ?? null,
      counts: { [kind]: 1 }, warnings: guards.warnings, forced: guards.blockers.length > 0,
      message: `Its booking no longer exists, so only this ${kind} was archived.`,
    };
  };

  return { previewItemDelete, deleteItem };
};