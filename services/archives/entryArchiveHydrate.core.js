// Archive-side twin of hydratePayments / hydratePenalties / hydrateRefundRequests (paymentEntries.core.js).
//
// A payment, penalty or refund request does not store its method / reference / paid date / refund parts: those
// are paymentEntries rows. When a booking is deleted its rows move to paymentEntryArchives, so the archive pages
// must look in BOTH collections -- a row is live (booking not deleted, or rows of an older archive that were left
// in place) or archived. A live row wins if both exist.
//
// Uses the same mapper functions, in the same "rowsOnly" mode, as the live readers. paymentEntries.core.js is
// not touched.
import {
  hydratePayment, hydratePenalty, hydrateRefundRequest,
} from "../paymentEntries/paymentEntries.mapper.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { LINKED, chunk } from "./linkedArchives.core.js";

const paymentKeyOf = (p) => p.paymentID || p.originalId || p.id;
const penaltyKeyOf = (p) => p.penaltyID || p.originalId || p.id;
const refundKeyOf  = (r) => r.refundRequestID || r.id;

export const makeEntryArchiveHydrate = (db) => {
  // field ("paymentID" | "penaltyID" | "refundReqID") + ids -> Map(id -> rows[]), live and archived rows together
  const getRows = async (field, ids) => {
    const keys = [...new Set((ids || []).filter(Boolean))];
    const map = new Map(keys.map((id) => [id, []]));
    const seen = new Set();
    for (const collection of [LINKED.paymentEntries.live, LINKED.paymentEntries.archive]) {   // live first: it wins
      for (const part of chunk(keys, 30)) {
        const snap = await db.collection(collection).where(field, "in", part).get();
        snap.docs.forEach((d) => {
          if (seen.has(d.id)) return;
          seen.add(d.id);
          const row = { id: d.id, ...stripArchiveMeta(d.data()) };
          if (map.has(row[field])) map.get(row[field]).push(row);
        });
      }
    }
    return map;
  };

  const hydratePaymentsWithArchives = async (payments) => {
    const list = payments || [];
    const map = await getRows("paymentID", list.map(paymentKeyOf));
    return list.map((p) => hydratePayment(p, map.get(paymentKeyOf(p)) || [], { rowsOnly: true }));
  };

  const hydratePenaltiesWithArchives = async (penalties) => {
    const list = penalties || [];
    const map = await getRows("penaltyID", list.map(penaltyKeyOf));
    return list.map((p) => hydratePenalty(p, map.get(penaltyKeyOf(p)) || [], { rowsOnly: true }));
  };

  const hydrateRefundRequestsWithArchives = async (requests) => {
    const list = requests || [];
    const map = await getRows("refundReqID", list.map(refundKeyOf));
    return list.map((r) => hydrateRefundRequest(r, map.get(refundKeyOf(r)) || [], { rowsOnly: true }));
  };

  return { hydratePaymentsWithArchives, hydratePenaltiesWithArchives, hydrateRefundRequestsWithArchives };
};
