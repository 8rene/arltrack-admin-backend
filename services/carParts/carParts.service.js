import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// ─────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────

export const listCarPartTypes = async () => {
  const snap = await db.collection("carPartTypes").get();
  return snap.docs.map((d) => ({ id: d.id, carPartName: d.data().carPartName || d.id }));
};

export const listCarPartsByCar = async (carID) => {
  const snap = await db.collection("carParts").where("carID", "==", carID).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

// ─────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────

// Matches Inventory.jsx's saveNew(): new parts always start "Good".
export const createCarPart = async ({ carID, carPartName, carPartTypeID, serialNumber }) => {
  if (!carID || !carPartName?.trim()) {
    const err = new Error("carID and carPartName are required.");
    err.statusCode = 400;
    throw err;
  }

  const payload = {
    carID,
    carPartName: carPartName.trim(),
    carPartTypeID: carPartTypeID || "",
    serialNumber: (serialNumber || "").trim(),
    status: "Good",
  };

  const ref = await db.collection("carParts").add(payload);
  return { id: ref.id, ...payload };
};

// Generic partial update — covers both Inventory.jsx's saveEdit() (name/type/
// serial) and Maintenance.jsx's markAsReplaced() (status/replacedAt/
// replacedType). Only the fields actually passed in `fields` get touched.
export const updateCarPart = async (id, fields) => {
  const { ref } = await getCarPartOrThrow(id);

  const allowed = ["carPartName", "carPartTypeID", "serialNumber", "status", "replacedType"];
  const update = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }
  if (fields.markReplaced) {
    update.status = "Replaced";
    update.replacedAt = admin.firestore.FieldValue.serverTimestamp();
  }

  if (Object.keys(update).length === 0) {
    const err = new Error("No valid fields to update.");
    err.statusCode = 400;
    throw err;
  }

  await ref.update(update);
  const updatedSnap = await ref.get();
  return { id, ...updatedSnap.data() };
};

export const deleteCarPart = async (id) => {
  const { ref, data } = await getCarPartOrThrow(id);
  await ref.delete();
  return { id, ...data };
};