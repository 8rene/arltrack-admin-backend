import { db } from "../../config/firebaseConnection/firebase.js";
import {
  parsePrice,
  getPricingMapForParts,
  upsertPricing,
  deletePricingByPartID,
} from "../carPartPricing/carPartPricing.service.js";

// The parts CATALOG of each vehicle (Inventory page): name, type, serial number, and the
// replacement price (kept in its own collection, carPartPricing — one doc per part).
//
// A part's `status` (its live condition) is NOT handled here. It is recomputed from the
// inspections and Completed maintenance jobs by carPartConditions.service.js, so nothing in
// this file writes it except createCarPart, which starts every new part at "Good".

// ─────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────

export const listCarPartTypes = async () => {
  const snap = await db.collection("carPartTypes").get();
  return snap.docs.map((d) => ({ id: d.id, carPartName: d.data().carPartName || d.id }));
};

// Every part of the car, each with its catalog price (price: null when unpriced).
export const listCarPartsByCar = async (carID) => {
  const snap = await db.collection("carParts").where("carID", "==", carID).get();
  const pricing = await getPricingMapForParts(snap.docs.map((d) => d.id));
  return snap.docs.map((d) => {
    const p = pricing.get(d.id);
    return { id: d.id, ...d.data(), price: p ? p.price : null, carPartPricingID: p?.id || null };
  });
};

const getCarPartOrThrow = async (id) => {
  const ref = db.collection("carParts").doc(id);
  const docSnap = await ref.get();
  if (!docSnap.exists) {
    const err = new Error("Car part not found.");
    err.statusCode = 404;
    throw err;
  }
  return { ref, data: docSnap.data() };
};

// "" / null / undefined all mean "no price given".
const hasPrice = (v) => v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");

// ─────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────

// Matches Inventory.jsx's saveNew(): new parts always start "Good", and the price (optional)
// is created together with the part.
export const createCarPart = async ({ carID, carPartName, carPartTypeID, serialNumber, price }) => {
  if (!carID || !carPartName?.trim()) {
    const err = new Error("carID and carPartName are required.");
    err.statusCode = 400;
    throw err;
  }
  // Validate the price BEFORE writing anything, so a bad price never leaves an unpriced part behind.
  if (hasPrice(price)) parsePrice(price);

  const payload = {
    carID,
    carPartName: carPartName.trim(),
    carPartTypeID: carPartTypeID || "",
    serialNumber: (serialNumber || "").trim(),
    status: "Good",
  };

  const ref = await db.collection("carParts").add(payload);

  let saved = null;
  if (hasPrice(price)) saved = await upsertPricing(ref.id, price);
  return { id: ref.id, ...payload, price: saved ? saved.price : null, carPartPricingID: saved?.id || null };
};

// Partial update — only the fields actually passed get touched.
//   carPartName / carPartTypeID / serialNumber -> the part itself
//   price: a number sets it, null or "" removes it, omitted leaves it alone
export const updateCarPart = async (id, fields) => {
  const { ref } = await getCarPartOrThrow(id);

  const allowed = ["carPartName", "carPartTypeID", "serialNumber"];
  const update = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }
  const priceSent = fields.price !== undefined;

  if (Object.keys(update).length === 0 && !priceSent) {
    const err = new Error("No valid fields to update.");
    err.statusCode = 400;
    throw err;
  }
  if (priceSent && hasPrice(fields.price)) parsePrice(fields.price); // validate before any write

  if (Object.keys(update).length > 0) await ref.update(update);

  if (priceSent) {
    if (hasPrice(fields.price)) await upsertPricing(id, fields.price);
    else await deletePricingByPartID(id);
  }

  const updatedSnap = await ref.get();
  const pricing = (await getPricingMapForParts([id])).get(id);
  return { id, ...updatedSnap.data(), price: pricing ? pricing.price : null, carPartPricingID: pricing?.id || null };
};

export const deleteCarPart = async (id) => {
  const { ref, data } = await getCarPartOrThrow(id);
  await ref.delete();
  await deletePricingByPartID(id); // a removed part's price record has nothing left to point at
  return { id, ...data };
};