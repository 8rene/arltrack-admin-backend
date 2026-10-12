// Read-only view of the money rows for the admin screens. `db` is injected so it runs against a fake in tests.
//
// One call answers "where did the money go?" for a payment, a penalty, a refund request or a whole booking:
// every row (in AND out), who handled it, and totals. It reads paymentEntries AND paymentEntryArchives (a booking's
// rows move to the archive collection when it is deleted), a live row winning if both exist -- the same rule as
// services/archives/entryArchiveHydrate.service.js. It never needs the parent document, so it also works for
// archived and orphaned records.
import { stripArchiveMeta } from "../archives/archiveMeta.js";

const LIVE = "paymentEntries";
const ARCHIVE = "paymentEntryArchives";
// request key -> the column on the row
const COLUMN = { paymentID: "paymentID", penaltyID: "penaltyID", refundRequestID: "refundReqID", bookingID: "bookingID" };

const toISO = (v) => (v?.toDate ? v.toDate().toISOString() : v instanceof Date ? v.toISOString() : v ?? null);
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

export const makeEntriesView = ({ db, resolveName = async (id) => id }) => {
  const loadRows = async (filter) => {
    const key = Object.keys(COLUMN).find((k) => filter?.[k]);
    if (!key) return [];
    const rows = new Map();
    for (const [collection, archived] of [[LIVE, false], [ARCHIVE, true]]) {     // live first: it wins
      const snap = await db.collection(collection).where(COLUMN[key], "==", filter[key]).get();
      snap.docs.forEach((d) => { if (!rows.has(d.id)) rows.set(d.id, { id: d.id, archived, ...stripArchiveMeta(d.data()) }); });
    }
    return [...rows.values()];
  };

  const summarize = (rows) => {
    const sum = (f) => round2(rows.filter(f).reduce((s, r) => s + num(r.amount), 0));
    const paidIn = sum((r) => r.direction === "in" && r.status === "success" && r.phase !== "penalty");
    const refundedOut = sum((r) => r.direction === "out" && r.status === "success" && r.phase !== "deposit_return");
    const depositReturned = sum((r) => r.direction === "out" && r.status === "success" && r.phase === "deposit_return");
    return {
      count: rows.length,
      paidIn,
      penaltyPaid: sum((r) => r.direction === "in" && r.status === "success" && r.phase === "penalty"),
      refundedOut,
      depositReturned,
      refundPending: sum((r) => r.direction === "out" && r.status === "pending"),
      unrefundable: sum((r) => r.direction === "out" && r.status === "unrefundable"),
      failed: sum((r) => r.status === "failed"),
      netHeld: round2(paidIn - refundedOut - depositReturned),
    };
  };

  const listEntries = async (filter) => {
    const rows = await loadRows(filter);
    const names = new Map();
    const nameOf = async (id) => { if (!id) return null; if (!names.has(id)) names.set(id, await resolveName(id).catch(() => id)); return names.get(id); };
    const when = (r) => toISO(r.settledAt) || toISO(r.processedAt) || toISO(r.createdAt) || "";
    const entries = [];
    for (const r of rows.sort((a, b) => when(a).localeCompare(when(b)) || String(a.id).localeCompare(String(b.id)))) {
      entries.push({
        id: r.id, archived: r.archived,
        paymentID: r.paymentID ?? null, bookingID: r.bookingID ?? null, refundReqID: r.refundReqID ?? null, penaltyID: r.penaltyID ?? null,
        direction: r.direction, phase: r.phase, source: r.source ?? null, method: r.method ?? null, amount: num(r.amount), status: r.status,
        referenceNumber: r.referenceNumber ?? null, sessionID: r.sessionID ?? null, transactionFee: r.transactionFee ?? null,
        processedBy: r.processedBy ?? null, processedByName: await nameOf(r.processedBy), processedAt: toISO(r.processedAt), settledAt: toISO(r.settledAt),
        groupID: r.groupID ?? null, errorNote: r.transactionErrorNote ?? null, createdAt: toISO(r.createdAt),
      });
    }
    return { entries, summary: summarize(entries) };
  };

  return { listEntries, summarize };
};