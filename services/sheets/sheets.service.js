// ── Sheets Service ──────────────────────────────────────────────────────────
// Replaces the Firestore bookingSessions/{id}/archive/{date} subcollection as
// the GPS ping-log store. One tab per PHT calendar date, shared across every
// car (not per-session) — same convention as the geo-test reference backend
// (backend.zip/sheets.js), ported to ESM and this app's row shape.
//
// Firebase Storage is UNCHANGED and stays exactly where it is as the final
// archive destination (see services/storage/bookingHistory.service.js) — it
// now just pulls the data it compiles from Sheets instead of Firestore.
//
// Auth: reuses FIREBASE_SERVICE_ACCOUNT — the same Google Cloud service
// account already used by config/firebaseConnection/firebase.js for
// Firestore/Storage. One service account, one Google Cloud project, both
// APIs. Parsed the exact same way firebase.js does (strip stray \r\n Vercel
// sometimes wraps the JSON in, then un-escape \\n back to real newlines in
// private_key) so both files stay in sync if that env var's formatting ever
// changes. Also required:
//   TRACEBACK_SHEET_ID — the spreadsheet's ID (the long id in its URL)
//
// Before this runs: the Sheets API must be enabled on this service account's
// Google Cloud project (Firestore/Storage being enabled doesn't imply
// Sheets is), AND the spreadsheet itself must be shared (Editor) with the
// service account's client_email — a key alone does not grant access to a
// sheet that was never shared with it.

import { google } from "googleapis";
import { phtDateFromInstant } from "../../utils/date/phtDate.js";

const SPREADSHEET_ID = process.env.TRACEBACK_SHEET_ID;

// Columns, in order, for every row written to a date tab.
// speed/offline appended at the END, not inserted in the middle — so any
// tabs already sitting in the spreadsheet from before this change don't get
// their existing columns silently relabeled.
const HEADERS = ["carId", "sessionId", "lat", "lng", "at", "speed", "offline"];

let sheetsClientPromise = null;

function loadServiceAccountCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/\r?\n/g, "");
  const credentials = JSON.parse(raw);
  credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
  return credentials;
}

function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        credentials: loadServiceAccountCredentials(),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
      const client = await auth.getClient();
      return google.sheets({ version: "v4", auth: client });
    })();
  }
  return sheetsClientPromise;
}

// Tab name == date string, e.g. "2026-07-22". Predictable, no lookup table needed.
function tabNameForDate(dateStr) {
  return dateStr;
}

/** Ensure a tab exists for a given date (creates it + header row if missing). */
async function ensureTabExists(dateStr) {
  if (!SPREADSHEET_ID) throw new Error("TRACEBACK_SHEET_ID is not set.");
  const sheets = await getSheetsClient();
  const tabName = tabNameForDate(dateStr);

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = meta.data.sheets.find((s) => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;

  const addResult = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  const newSheetId = addResult.data.replies[0].addSheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  console.log(`[SHEETS] Created tab ${tabName}`);
  return newSheetId;
}

/**
 * Append one GPS ping to its date's tab — direct, fire-and-forget append.
 * No interval/batch buffer here (unlike the geo-test's sheetsBuffer.js):
 * this app deploys to Vercel, which can freeze or kill a serverless function
 * instance the moment its response is sent, so a setInterval-based buffer
 * could silently drop pings sitting in memory. One extra Sheets API call per
 * ping instead of a batched write, in exchange for actually persisting.
 *
 * @param {{ carId: string, sessionId?: string, lat: number, lng: number, at: string,
 *   speed?: number, offline?: boolean }} ping
 *   `at` must be an ISO string; its date portion decides which tab it lands in.
 *   `speed` (km/h, from the tracker's own reading) and `offline` (true when the
 *   tracker buffered this ping while it had no signal, sent later on reconnect)
 *   default to 0/false when not provided by older callers.
 */
export const appendCarPing = async ({ carId, sessionId, lat, lng, at, speed = 0, offline = false }) => {
  // `at` is a UTC ISO string (now.toISOString() from livePing.service.js).
  // Naively slicing its date portion mislabels every ping sent between
  // UTC midnight and 8AM (PHT is UTC+8) as the previous PHT day — e.g.
  // 2026-07-24T22:30Z is actually 2026-07-25 6:30AM in Manila, but a plain
  // split("T")[0] would file it under the "2026-07-24" tab. Convert first.
  const dateStr = phtDateFromInstant(at);
  await ensureTabExists(dateStr);
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabNameForDate(dateStr)}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[carId, sessionId || "", lat, lng, at, speed, offline]] },
  });
};

// ── Tab-rows cache ───────────────────────────────────────────────────────
// The Traceback tab asks for one date's rows PER CAR (Promise.allSettled
// over every car in gps.controller.js's getCarTraceback), but every one of
// those requests reads the exact same tab and then filters client-side —
// so N cars used to mean N identical Sheets API reads for one date. On top
// of that, whatever re-triggers the frontend's fetch (the Refresh button,
// a re-render, switching days) fires the whole batch again.
//
// tabRowsCache holds, per date string, either the last good rows + when they
// were fetched, or an in-flight promise other callers can just await instead
// of starting their own request. This turns "N cars × M re-fetches" into
// roughly one real Sheets read per date per TTL window — the fix for
// hitting the Sheets API's read-quota ceiling — without changing any
// response shape callers rely on. TTL is intentionally short: pings land
// in Sheets in near-real-time, so this is about collapsing duplicate/rapid
// reads, not about serving genuinely stale data.
const TAB_ROWS_CACHE_TTL_MS = 15_000;
const tabRowsCache = new Map(); // dateStr -> { rows, fetchedAt, inflight }

function parseTabRows(values) {
  return (values || []).map((row) => {
    const record = {};
    HEADERS.forEach((h, i) => { record[h] = row[i] ?? null; });
    record.lat = record.lat !== null ? parseFloat(record.lat) : null;
    record.lng = record.lng !== null ? parseFloat(record.lng) : null;
    // speed defaults to 0 for rows written before this column existed.
    record.speed = record.speed !== null ? parseFloat(record.speed) || 0 : 0;
    // Sheets returns booleans back as the strings "TRUE"/"FALSE", not real
    // true/false — normalize once here (same pattern as the geo-test
    // reference backend) so `offline` is a real boolean everywhere downstream.
    record.offline = String(record.offline).toUpperCase() === "TRUE";
    return record;
  });
}

async function fetchTabRowsFromSheets(dateStr) {
  const sheets = await getSheetsClient();
  const tabName = tabNameForDate(dateStr);
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!A2:G`, // skip header row; G covers speed/offline
    });
    return parseTabRows(res.data.values);
  } catch (err) {
    if (err.code === 400 || err.code === 404) return []; // tab doesn't exist yet
    throw err;
  }
}

/**
 * All rows for a given date's tab. Returns [] if the tab doesn't exist (no
 * data that day). Cached + de-duped per date — see tabRowsCache above.
 * Pass `{ force: true }` to bypass the cache (e.g. an explicit user-driven
 * refresh that should reflect pings written in the last few seconds).
 */
export const fetchTabRows = async (dateStr, { force = false } = {}) => {
  if (!SPREADSHEET_ID) throw new Error("TRACEBACK_SHEET_ID is not set.");

  const cached = tabRowsCache.get(dateStr);

  // Someone else's request for this same date is already in flight —
  // piggyback on it instead of starting a second identical Sheets read.
  if (cached?.inflight) return cached.inflight;

  if (!force && cached && Date.now() - cached.fetchedAt < TAB_ROWS_CACHE_TTL_MS) {
    return cached.rows;
  }

  const inflight = fetchTabRowsFromSheets(dateStr)
    .then((rows) => {
      tabRowsCache.set(dateStr, { rows, fetchedAt: Date.now(), inflight: null });
      return rows;
    })
    .catch((err) => {
      // Don't cache the failure — drop back to whatever we had before (if
      // anything) so the next call gets a clean retry against Sheets.
      if (cached) tabRowsCache.set(dateStr, { ...cached, inflight: null });
      else tabRowsCache.delete(dateStr);
      throw err;
    });

  tabRowsCache.set(dateStr, { rows: cached?.rows || [], fetchedAt: cached?.fetchedAt || 0, inflight });
  return inflight;
};

/** Rows for one car on one date. */
export const fetchCarRowsForDate = async (carId, dateStr, opts) => {
  const rows = await fetchTabRows(dateStr, opts);
  return rows.filter((r) => r.carId === carId);
};

/** Rows for one car across several dates (e.g. Traceback's day-by-day scrub), in order. */
export const fetchCarRowsForDateRange = async (carId, dateStrings) => {
  const all = [];
  for (const dateStr of dateStrings) {
    all.push(...(await fetchCarRowsForDate(carId, dateStr)));
  }
  return all;
};

/**
 * Rows for one specific booking session, across whatever dates it spans —
 * powers bookingHistory.service.js's flush-to-Storage compile. dateStrings
 * should cover every calendar date the session was active for.
 */
export const fetchSessionRows = async (carId, sessionId, dateStrings) => {
  const all = [];
  for (const dateStr of dateStrings) {
    const rows = await fetchCarRowsForDate(carId, dateStr);
    all.push(...rows.filter((r) => String(r.sessionId) === String(sessionId)));
  }
  return all;
};