// Pure rules for "has this car's tracker gone quiet?" — no Firebase imports, so it can be tested on its own.

/** A car on an active trip with a tracker that has sent nothing for this long counts as silent. */
export const SILENT_AFTER_MS = 10 * 60 * 1000;

const toMs = (v) => {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate().getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * The latest sign of life for a session, in ms: the server's last-received time, the last recorded
 * position time, or the trip start — whichever is newest. (A replayed offline fix carries an old
 * position time, which is why the server-side time is included.) null if none of them is known.
 */
export const lastSeenMs = (data) => {
  const times = [toMs(data?.lastPingReceivedAt), toMs(data?.currentPosition?.date), toMs(data?.startedAt)].filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
};

/**
 * @param {{ref?: any, data: object}[]} sessions   active sessions
 * @param {Set<string>} assignedCarIDs             cars that currently have a GPS device assigned
 * @returns the sessions that are silent and not yet alerted, each with `silentForMs`
 */
export const findSilentSessions = (sessions, assignedCarIDs, nowMs, thresholdMs = SILENT_AFTER_MS) => {
  const out = [];
  for (const s of sessions) {
    const d = s.data || {};
    if (!d.carID || !assignedCarIDs.has(d.carID)) continue; // no tracker on this car -> nothing to wait for
    if (d.silentAlertedAt) continue;                        // already alerted for this silence
    const seen = lastSeenMs(d);
    if (seen === null) continue;
    const silentForMs = nowMs - seen;
    if (silentForMs >= thresholdMs) out.push({ ...s, silentForMs });
  }
  return out;
};