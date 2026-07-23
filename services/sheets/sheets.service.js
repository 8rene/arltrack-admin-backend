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

const SPREADSHEET_ID = process.env.TRACEBACK_SHEET_ID;

// Columns, in order, for every row written to a date tab.
const HEADERS = ["carId", "sessionId", "lat", "lng", "at"];

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
 * @param {{ carId: string, sessionId?: string, lat: number, lng: number, at: string }} ping
 *   `at` must be an ISO string; its date portion decides which tab it lands in.
 */
export const appendCarPing = async ({ carId, sessionId, lat, lng, at }) => {
  const dateStr = at.split("T")[0];
  await ensureTabExists(dateStr);
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabNameForDate(dateStr)}!A:A`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[carId, sessionId || "", lat, lng, at]] },
  });
};

/** All rows for a given date's tab. Returns [] if the tab doesn't exist (no data that day). */
export const fetchTabRows = async (dateStr) => {
  if (!SPREADSHEET_ID) throw new Error("TRACEBACK_SHEET_ID is not set.");
  const sheets = await getSheetsClient();
  const tabName = tabNameForDate(dateStr);

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${tabName}!A2:E`, // skip header row
    });
    const rows = res.data.values || [];
    return rows.map((row) => {
      const record = {};
      HEADERS.forEach((h, i) => { record[h] = row[i] ?? null; });
      record.lat = record.lat !== null ? parseFloat(record.lat) : null;
      record.lng = record.lng !== null ? parseFloat(record.lng) : null;
      return record;
    });
  } catch (err) {
    if (err.code === 400 || err.code === 404) return []; // tab doesn't exist yet
    throw err;
  }
};

/** Rows for one car on one date. */
export const fetchCarRowsForDate = async (carId, dateStr) => {
  const rows = await fetchTabRows(dateStr);
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