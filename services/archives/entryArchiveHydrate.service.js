// Archive-side twin of hydratePayments / hydratePenalties / hydrateRefundRequests (paymentEntries.core.js).
//
// A payment, penalty or refund request does not store its method / reference / paid date / refund parts: those are
// paymentEntries rows. When a booking is deleted its rows move to paymentEntryArchives, so the archive pages look in
// BOTH collections (a live row wins if both exist). Same mapper functions, in "rowsOnly" mode, as the live readers.
import { db } from "../../config/firebaseConnection/firebase.js";
import { hydratePayment, hydratePenalty, hydrateRefundRequest } from "../paymentEntries/paymentEntries.mapper.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { LINKED, chunk } from "./linkedArchives.service.js";

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
        map.get(row[field])?.push(row);
      });
    }
  }
  return map;
};

const hydrateAll = (field, keyOf, hydrate) => async (items) => {
  const rows = items || [];
  const map = await getRows(field, rows.map(keyOf));
  return rows.map((x) => hydrate(x, map.get(keyOf(x)) || [], { rowsOnly: true }));
};

export const hydratePaymentsWithArchives = hydrateAll("paymentID", (p) => p.paymentID || p.originalId || p.id, hydratePayment);
export const hydratePenaltiesWithArchives = hydrateAll("penaltyID", (p) => p.penaltyID || p.originalId || p.id, hydratePenalty);
export const hydrateRefundRequestsWithArchives = hydrateAll("refundReqID", (r) => r.refundRequestID || r.id, hydrateRefundRequest);