// ================================
//  CRON — prune old Sheets date tabs
//  Runs after the midnight archive flush. Deletes date tabs older than the
//  retention window (default: keep today + the 2 days before it, so on the
//  4th the tab for the 1st is removed).
//
//  A tab is NEVER deleted while a trip still needs it: an active or stolen
//  trip, or an ended one whose final save is still pending, is compiled from
//  every tab since its start. Pruning stops short of the earliest such date.
// ================================

import { db } from "../config/firebaseConnection/firebase.js";
import { getAllActiveSessions, getSessionsNeedingFinalFlush } from "../services/booking/bookingSession.service.js";
import { listDateTabs, deleteTabs } from "../services/sheets/sheets.service.js";
import { phtDateFromInstant } from "../utils/date/phtDate.js";
import { sessionStartedAt } from "../utils/date/sessionDates.js";

const KEEP_DAYS = 3;

const shiftDate = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
};

export const runPruneSheetTabs = async ({ keepDays = KEEP_DAYS, dryRun = false } = {}) => {
  const today = phtDateFromInstant(new Date());
  const cutoff = shiftDate(today, -keepDays); // tabs dated on/before this are past retention

  // Trips that still read old tabs: active, stolen (car keeps pinging), or awaiting a final save.
  const [active, pending, stolenSnap] = await Promise.all([
    getAllActiveSessions(),
    getSessionsNeedingFinalFlush(),
    db.collection("bookingSessions").where("status", "==", "stolen").get(),
  ]);
  const needed = [...active, ...pending, ...stolenSnap.docs.map((d) => ({ data: d.data() }))];

  let earliestNeeded = null;
  for (const { data } of needed) {
    const started = sessionStartedAt(data);
    if (!started) {
      // Can't tell which tabs this trip needs — do nothing rather than risk its trail.
      return { skipped: true, reason: `session ${data.bookingSessionID || "?"} has no start date`, deleted: [] };
    }
    const startDate = phtDateFromInstant(started);
    if (!earliestNeeded || startDate < earliestNeeded) earliestNeeded = startDate;
  }

  const { tabs, totalSheets } = await listDateTabs();
  const toDelete = tabs.filter((t) => t.date <= cutoff && (!earliestNeeded || t.date < earliestNeeded));

  // A spreadsheet must keep at least one tab.
  if (toDelete.length >= totalSheets) {
    return { skipped: true, reason: "would delete every tab", deleted: [] };
  }

  if (!dryRun) await deleteTabs(toDelete);

  const result = {
    dryRun,
    today,
    cutoff,
    earliestNeeded,
    deleted: toDelete.map((t) => t.title),
  };
  console.log(`[CRON] 🧹 Sheet tab prune ${dryRun ? "(dry run) " : ""}- ${toDelete.length} tab(s): ${result.deleted.join(", ") || "none"}`);
  return result;
};