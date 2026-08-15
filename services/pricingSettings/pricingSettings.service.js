import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const COLLECTION = "systemSettings";
const DOC_ID = "pricing";

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
  // billingBlockHours intentionally omitted — see pricingSettings.model.js
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
// Get current settings. Seeds the doc with DEFAULTS on first read so the
// doc always exists after the first GET (simplifies the frontend — it
// never has to handle "no doc yet").
// ─────────────────────────────────────────────
export const getPricingSettings = async () => {
  const ref = db.collection(COLLECTION).doc(DOC_ID);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set({ ...DEFAULTS, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: null });
    return { ...DEFAULTS, updatedAt: null, updatedBy: null };
  }

  return { ...DEFAULTS, ...snap.data() };
};

// ─────────────────────────────────────────────
// Update settings. Only accepts known fields — silently drops anything
// else in the payload so a stray/unexpected field can't get written.
// Validates numeric fields are numbers >= 0 before saving.
// ─────────────────────────────────────────────
export const updatePricingSettings = async (payload, actor) => {
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

  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  update.updatedBy = actor ? { userID: actor.userID || actor.id || null, name: actor.name || actor.username || null } : null;

  const ref = db.collection(COLLECTION).doc(DOC_ID);
  await ref.set(update, { merge: true });

  const snap = await ref.get();
  return { ...DEFAULTS, ...snap.data() };
};