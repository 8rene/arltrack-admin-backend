import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  parseYmd,
  ymdToTimestamp,
  timestampToYmd,
  weekdayName,
  retraceDate,
} from "../../utils/date/holidayCalendar.js";

const COLLECTION = "holidays";
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const BATCH_LIMIT = 400; // Firestore caps a batch at 500 writes

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// holidayDay is always derived from the date here, never trusted from the
// client — the two can't drift apart.
const shape = (doc) => {
  const d = doc.data();
  const ymd = timestampToYmd(d.holidayDate);
  return {
    id: doc.id,
    holidayID: d.holidayID || doc.id,
    holidayName: d.holidayName || "",
    holidayDate: ymd, // "YYYY-MM-DD" (Manila calendar date) or null if the doc has no valid date
    holidayDay: ymd ? weekdayName(ymd) : d.holidayDay || "",
    createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : null,
  };
};

const byDate = (a, b) => {
  if (a.holidayDate === b.holidayDate) return a.holidayName.localeCompare(b.holidayName);
  if (!a.holidayDate) return 1;
  if (!b.holidayDate) return -1;
  return a.holidayDate < b.holidayDate ? -1 : 1;
};

const cleanInput = ({ holidayName, holidayDate }) => {
  const name = String(holidayName ?? "").trim();
  if (!name) throw httpError(400, "Enter a holiday name.");
  if (!parseYmd(holidayDate)) throw httpError(400, "Enter a valid date (YYYY-MM-DD).");
  return { name, ymd: holidayDate.trim() };
};

export const listHolidays = async () => {
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map(shape).sort(byDate);
};

export const createHoliday = async (input) => {
  const { name, ymd } = cleanInput(input);
  const ref = db.collection(COLLECTION).doc();
  await ref.set({
    holidayID: ref.id,
    holidayName: name,
    holidayDate: ymdToTimestamp(ymd),
    holidayDay: weekdayName(ymd),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return shape(await ref.get());
};

export const updateHoliday = async (id, input) => {
  const { name, ymd } = cleanInput(input);
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Holiday not found.");
  await ref.update({
    holidayName: name,
    holidayDate: ymdToTimestamp(ymd),
    holidayDay: weekdayName(ymd),
  });
  return shape(await ref.get());
};

export const deleteHoliday = async (id) => {
  const ref = db.collection(COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Holiday not found.");
  const removed = shape(snap);
  await ref.delete();
  return removed;
};

/**
 * Retraces every holiday onto `year` (movable holidays use that year's real
 * date, everything else keeps its month/day) and rewrites holidayDate +
 * holidayDay together. Batched, so switching years is one round trip rather
 * than one write per holiday.
 */
export const retraceHolidaysToYear = async (year) => {
  const y = Number(year);
  if (!Number.isInteger(y) || y < MIN_YEAR || y > MAX_YEAR) {
    throw httpError(400, `Year must be between ${MIN_YEAR} and ${MAX_YEAR}.`);
  }

  const snap = await db.collection(COLLECTION).get();
  const updates = [];
  for (const doc of snap.docs) {
    const h = shape(doc);
    if (!h.holidayDate) continue; // nothing to retrace for a doc with no valid date
    const next = retraceDate(h.holidayName, h.holidayDate, y);
    if (!next) continue;
    updates.push({ ref: doc.ref, ymd: next });
  }

  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    updates.slice(i, i + BATCH_LIMIT).forEach(({ ref, ymd }) => {
      batch.update(ref, { holidayDate: ymdToTimestamp(ymd), holidayDay: weekdayName(ymd) });
    });
    await batch.commit();
  }

  return { updated: updates.length, data: await listHolidays() };
};
