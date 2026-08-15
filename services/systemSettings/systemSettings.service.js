import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const COLLECTION = "systemSettings";
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

// Defaults mirror the current hardcoded constants in
// customer-backend/utils/pricing.js, so the very first read (before anyone
// has saved anything from the admin panel) returns the same numbers the
// system already charges today — nothing changes until someone edits it.
const DEFAULTS = {
  serviceFee: 50,
  gatewayFee: 53,
  depositFee: 1000,
  extraFeeOutsideArea: 500,
  driversFeeBaseArea: 1000,
  driversFeeOutsideArea: 1500,
  baseAreaKeywords: ["manila", "bulacan"],
  // billingBlockHours intentionally omitted — see systemSettings.model.js
  // for why it stays a hardcoded constant in the customer backend instead.
};

const NUMERIC_FIELDS = [
  "serviceFee",
  "gatewayFee",
  "depositFee",
  "extraFeeOutsideArea",
  "driversFeeBaseArea",
  "driversFeeOutsideArea",
];

// ─────────────────────────────────────────────
// systemSettings is a single combined doc shape — NOT split by a "type"
// field. Every save writes one complete snapshot containing every setting
// area (pricing today; other areas like maintenance can add their own
// fields onto this same doc shape later). There is only ever one kind of
// document in this collection.
//
// Get current settings. Reads the most recent doc (createdAt desc). If
// none exists yet, seeds one with DEFAULTS so the collection always has a
// doc after the first GET (simplifies the frontend — it never has to
// handle "no doc yet").
// ─────────────────────────────────────────────
export const getSystemSettings = async () => {
  const snap = await db
    .collection(COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(1)
    .get();

  if (snap.empty) {
    const ref = await db.collection(COLLECTION).add({
      ...DEFAULTS,
      createdAt: timestamp(),
      updatedBy: null,
    });

    // Mirror the doc's own ID onto itself, matching this app's existing convention
    await ref.update({ systemSettingsID: ref.id });

    return { ...DEFAULTS, systemSettingsID: ref.id, createdAt: null, updatedBy: null };
  }

  return { ...DEFAULTS, ...snap.docs[0].data() };
};

// ─────────────────────────────────────────────
// Update settings. Only accepts known pricing fields — silently drops
// anything else in the payload so a stray/unexpected field can't get
// written. Validates numeric fields are numbers >= 0 before saving.
//
// Follows the same append-only pattern as the rest of the app (e.g.
// carMaintenance): every save creates a NEW doc rather than mutating the
// old one, carrying forward every existing field (pricing AND any other
// settings area that later gets added onto this same doc) so a partial
// save never wipes out unrelated settings. systemSettings doubles as a
// full history of every settings change; getSystemSettings() always
// reads back the most recent doc.
// ─────────────────────────────────────────────
export const updateSystemSettings = async (payload, actor) => {
  // Start from the current settings so a partial payload (e.g. just
  // { serviceFee }) still produces a complete new doc, not a sparse one —
  // this is what protects fields from OTHER settings areas (e.g. future
  // maintenance fields) from being dropped when only pricing is saved.
  const current = await getSystemSettings();
  const update = {};

  for (const field of NUMERIC_FIELDS) {
    if (payload[field] === undefined) continue;
    const num = Number(payload[field]);
    if (!Number.isFinite(num) || num < 0) {
      throw new Error(`${field} must be a number >= 0.`);
    }
    update[field] = num;
  }

  if (payload.baseAreaKeywords !== undefined) {
    if (!Array.isArray(payload.baseAreaKeywords)) {
      throw new Error("baseAreaKeywords must be an array of strings.");
    }
    update.baseAreaKeywords = payload.baseAreaKeywords
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean);
  }

  if (Object.keys(update).length === 0) {
    throw new Error("No valid fields to update.");
  }

  const { systemSettingsID, createdAt, ...rest } = current;

  const ref = await db.collection(COLLECTION).add({
    ...rest,
    ...update,
    createdAt: timestamp(),
    updatedBy: actor ? { userID: actor.userID || actor.id || null, name: actor.name || actor.username || null } : null,
  });

  // Mirror the doc's own ID onto itself, matching this app's existing convention
  await ref.update({ systemSettingsID: ref.id });

  const snap = await ref.get();
  return { ...DEFAULTS, ...snap.data() };
};