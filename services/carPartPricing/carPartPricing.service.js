import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const COLLECTION = "carPartPricing";

// Firestore "in" queries accept at most 30 values.
const IN_LIMIT = 30;

const httpError = (message, statusCode) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

// Accepts a number or a numeric string. Throws 400 on anything else.
export const parsePrice = (value) => {
  if (value === null || value === undefined || value === "") {
    throw httpError("price is required.", 400);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw httpError("price must be a number that is 0 or greater.", 400);
  }
  // Round to centavos so float noise (e.g. 0.1 + 0.2) never gets stored.
  return Math.round(n * 100) / 100;
};

const shape = (docSnap) => ({
  id: docSnap.id,
  carPartPricingID: docSnap.id,
  ...docSnap.data(),
});

// ─────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────

export const getPricingByPartID = async (carPartID) => {
  const snap = await db
    .collection(COLLECTION)
    .where("carPartID", "==", carPartID)
    .limit(1)
    .get();
  return snap.empty ? null : shape(snap.docs[0]);
};

// Returns Map<carPartID, pricingDoc> for the given part IDs.
export const getPricingMapForParts = async (partIDs) => {
  const map = new Map();
  for (let i = 0; i < partIDs.length; i += IN_LIMIT) {
    const chunk = partIDs.slice(i, i + IN_LIMIT);
    const snap = await db.collection(COLLECTION).where("carPartID", "in", chunk).get();
    snap.docs.forEach((d) => map.set(d.data().carPartID, shape(d)));
  }
  return map;
};

// Every part of a car, each with its pricing (price: null when unpriced).
export const listPricingByCar = async (carID) => {
  const partsSnap = await db.collection("carParts").where("carID", "==", carID).get();
  const partIDs = partsSnap.docs.map((d) => d.id);
  const pricingMap = await getPricingMapForParts(partIDs);

  return partsSnap.docs.map((d) => {
    const p = pricingMap.get(d.id);
    return {
      carPartID: d.id,
      carPartName: d.data().carPartName || "",
      carPartPricingID: p?.id || null,
      price: p ? p.price : null,
      updatedAt: p?.updatedAt || null,
    };
  });
};

// ─────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────

// Create the pricing doc for a part, or update it if one already exists.
// Runs in a transaction so two simultaneous saves can't create duplicates.
export const upsertPricing = async (carPartID, rawPrice) => {
  const price = parsePrice(rawPrice);

  const partSnap = await db.collection("carParts").doc(carPartID).get();
  if (!partSnap.exists) throw httpError("Car part not found.", 404);

  const query = db.collection(COLLECTION).where("carPartID", "==", carPartID).limit(1);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async (t) => {
    const snap = await t.get(query);
    if (snap.empty) {
      const ref = db.collection(COLLECTION).doc();
      t.set(ref, { carPartID, price, createdAt: now, updatedAt: now });
      return { ref, created: true };
    }
    const ref = snap.docs[0].ref;
    t.update(ref, { price, updatedAt: now });
    return { ref, created: false };
  });

  const saved = await result.ref.get();
  return { ...shape(saved), created: result.created, carPartName: partSnap.data().carPartName || "" };
};

export const deletePricingByPartID = async (carPartID) => {
  const snap = await db.collection(COLLECTION).where("carPartID", "==", carPartID).get();
  if (snap.empty) return null;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  return snap.docs.map((d) => d.id);
};