import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const sortPricing = (pricing = []) =>
  [...pricing].sort((a, b) => {
    const aIs12 = a.durationType?.toLowerCase().includes("12");
    const bIs12 = b.durationType?.toLowerCase().includes("12");
    if (aIs12 && !bIs12) return 1;
    if (!aIs12 && bIs12) return -1;
    return 0;
  });

// ─────────────────────────────────────────────
// GET all cars (with images + pricing + brand/model names)
// ─────────────────────────────────────────────
export const getAllCars = async () => {
  const [carsSnap, imgSnap, priceSnap, brandSnap, modelSnap] = await Promise.all([
    db.collection("cars").get(),
    db.collection("carImages").get(),
    db.collection("carPricing").get(),
    db.collection("brand").get(),
    db.collection("model").get(),
  ]);

  const imgMap = {};
  imgSnap.docs.forEach(d => {
    const { carID, imageURL, isPrimary } = d.data();
    if (!imgMap[carID] || isPrimary) imgMap[carID] = imageURL;
  });

  const priceMap = {};
  priceSnap.docs.forEach(d => {
    const { carID, price, durationType } = d.data();
    if (!priceMap[carID]) priceMap[carID] = [];
    priceMap[carID].push({ id: d.id, price, durationType });
  });

  const brandMap = Object.fromEntries(brandSnap.docs.map(d => [d.id, d.data().brandName]));
  const modelMap = Object.fromEntries(modelSnap.docs.map(d => [d.id, d.data().modelName]));

  return carsSnap.docs.map(d => ({
    id: d.id,
    ...d.data(),
    imageURL:  imgMap[d.id] || null,
    pricing:   sortPricing(priceMap[d.id] || []),
    brandName: brandMap[d.data().brandID] || "—",
    modelName: modelMap[d.data().modelID] || "—",
  }));
};

// ─────────────────────────────────────────────
// GET single car by ID
// ─────────────────────────────────────────────
export const getCarById = async (carID) => {
  const carDoc = await db.collection("cars").doc(carID).get();
  if (!carDoc.exists) throw new Error("Car not found.");

  const carData = carDoc.data();

  const [imgSnap, priceSnap, brandSnap, modelSnap] = await Promise.all([
    db.collection("carImages").where("carID", "==", carID).get(),
    db.collection("carPricing").where("carID", "==", carID).get(),
    carData.brandID ? db.collection("brand").doc(carData.brandID).get() : Promise.resolve(null),
    carData.modelID ? db.collection("model").doc(carData.modelID).get() : Promise.resolve(null),
  ]);

  const images = imgSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const pricing = sortPricing(priceSnap.docs.map(d => ({ id: d.id, ...d.data() })));
  const brandName = brandSnap?.exists ? brandSnap.data().brandName : "—";
  const modelName = modelSnap?.exists ? modelSnap.data().modelName : "—";

  return { id: carID, ...carData, images, pricing, brandName, modelName };
};

// ─────────────────────────────────────────────
// ADD car (without image — image handled separately or by frontend)
// ─────────────────────────────────────────────
export const addCar = async (carData) => {
  const { brandID, modelID, pricing = [], ...rest } = carData;

  if (!brandID || !modelID) throw new Error("brandID and modelID are required.");

  const carRef = await db.collection("cars").add({
    ...rest,
    brandID,
    modelID,
    seatingCapacity: Number(rest.seatingCapacity) || 0,
    year: Number(rest.year) || 0,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });

  // Save pricing tiers
  for (const p of pricing) {
    if (p.durationType && p.price) {
      await db.collection("carPricing").add({
        carID: carRef.id,
        price: Number(p.price),
        durationType: p.durationType,
      });
    }
  }

  return { id: carRef.id };
};

// ─────────────────────────────────────────────
// UPDATE car details
// ─────────────────────────────────────────────
export const updateCar = async (carID, carData) => {
  const carRef = db.collection("cars").doc(carID);
  const carDoc = await carRef.get();
  if (!carDoc.exists) throw new Error("Car not found.");

  const { pricing, ...rest } = carData;

  await carRef.update({
    ...rest,
    seatingCapacity: Number(rest.seatingCapacity) || rest.seatingCapacity,
    year: Number(rest.year) || rest.year,
    updatedAt: timestamp(),
  });

  return { id: carID };
};

// ─────────────────────────────────────────────
// UPDATE car status only
// ─────────────────────────────────────────────
export const updateCarStatus = async (carID, status) => {
  const validStatuses = ["Active", "Rented", "Reserved", "Maintenance"];
  if (!validStatuses.includes(status)) throw new Error(`Invalid status. Must be one of: ${validStatuses.join(", ")}`);

  const carRef = db.collection("cars").doc(carID);
  const carDoc = await carRef.get();
  if (!carDoc.exists) throw new Error("Car not found.");

  await carRef.update({ status, updatedAt: timestamp() });
  return { id: carID, status };
};

// ─────────────────────────────────────────────
// DELETE car (also removes its images and pricing)
// ─────────────────────────────────────────────
export const deleteCar = async (carID) => {
  const carDoc = await db.collection("cars").doc(carID).get();
  if (!carDoc.exists) throw new Error("Car not found.");

  const batch = db.batch();

  // Queue car deletion
  batch.delete(db.collection("cars").doc(carID));

  // Queue carImages deletion
  const imgSnap = await db.collection("carImages").where("carID", "==", carID).get();
  imgSnap.docs.forEach(d => batch.delete(d.ref));

  // Queue carPricing deletion
  const priceSnap = await db.collection("carPricing").where("carID", "==", carID).get();
  priceSnap.docs.forEach(d => batch.delete(d.ref));

  await batch.commit();
  return { id: carID, deleted: true };
};

// ─────────────────────────────────────────────
// PRICING — Get pricing tiers for a car
// ─────────────────────────────────────────────
export const getPricingByCar = async (carID) => {
  const snap = await db.collection("carPricing").where("carID", "==", carID).get();
  return sortPricing(snap.docs.map(d => ({ id: d.id, ...d.data() })));
};

// ─────────────────────────────────────────────
// PRICING — Add a single pricing tier
// ─────────────────────────────────────────────
export const addPricingTier = async (carID, { durationType, price }) => {
  if (!durationType || price === undefined || price === "") {
    throw new Error("durationType and price are required.");
  }
  const ref = await db.collection("carPricing").add({
    carID,
    durationType,
    price: Number(price),
  });
  return { id: ref.id, carID, durationType, price: Number(price) };
};

// ─────────────────────────────────────────────
// PRICING — Update a single pricing tier
// ─────────────────────────────────────────────
export const updatePricingTier = async (pricingID, { durationType, price }) => {
  const ref = db.collection("carPricing").doc(pricingID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Pricing tier not found.");
  await ref.update({ durationType, price: Number(price) });
  return { id: pricingID, durationType, price: Number(price) };
};

// ─────────────────────────────────────────────
// PRICING — Delete a single pricing tier
// ─────────────────────────────────────────────
export const deletePricingTier = async (pricingID) => {
  const ref = db.collection("carPricing").doc(pricingID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Pricing tier not found.");
  await ref.delete();
  return { id: pricingID, deleted: true };
};

// ─────────────────────────────────────────────
// PRICING — Bulk replace all pricing tiers for a car
// (delete existing, insert new list)
// ─────────────────────────────────────────────
export const replacePricingForCar = async (carID, pricingList = []) => {
  const existingSnap = await db.collection("carPricing").where("carID", "==", carID).get();

  const batch = db.batch();
  existingSnap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();

  const newTiers = [];
  for (const p of pricingList) {
    if (p.durationType && p.price !== undefined && p.price !== "") {
      const ref = await db.collection("carPricing").add({
        carID,
        durationType: p.durationType,
        price: Number(p.price),
      });
      newTiers.push({ id: ref.id, carID, durationType: p.durationType, price: Number(p.price) });
    }
  }

  return sortPricing(newTiers);
};

// ─────────────────────────────────────────────
// BRANDS — Get all brands
// ─────────────────────────────────────────────
export const getAllBrands = async () => {
  const snap = await db.collection("brand").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ─────────────────────────────────────────────
// BRANDS — Add brand
// ─────────────────────────────────────────────
export const addBrand = async (brandName) => {
  if (!brandName?.trim()) throw new Error("brandName is required.");
  const ref = await db.collection("brand").add({ brandName: brandName.trim() });
  await ref.update({ brandID: ref.id });
  return { id: ref.id, brandName: brandName.trim() };
};

// ─────────────────────────────────────────────
// BRANDS — Delete brand (also removes its models)
// ─────────────────────────────────────────────
export const deleteBrand = async (brandID) => {
  const brandDoc = await db.collection("brand").doc(brandID).get();
  if (!brandDoc.exists) throw new Error("Brand not found.");

  const batch = db.batch();
  batch.delete(db.collection("brand").doc(brandID));

  const modelsSnap = await db.collection("model").where("brandID", "==", brandID).get();
  modelsSnap.docs.forEach(d => batch.delete(d.ref));

  await batch.commit();
  return { id: brandID, deleted: true };
};

// ─────────────────────────────────────────────
// MODELS — Get all models (optionally filter by brandID)
// ─────────────────────────────────────────────
export const getAllModels = async (brandID) => {
  let q = db.collection("model");
  if (brandID) q = q.where("brandID", "==", brandID);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

// ─────────────────────────────────────────────
// MODELS — Add model
// ─────────────────────────────────────────────
export const addModel = async (modelName, brandID) => {
  if (!modelName?.trim() || !brandID) throw new Error("modelName and brandID are required.");
  const ref = await db.collection("model").add({ modelName: modelName.trim(), brandID });
  await ref.update({ modelID: ref.id });
  return { id: ref.id, modelName: modelName.trim(), brandID };
};

// ─────────────────────────────────────────────
// MODELS — Delete model
// ─────────────────────────────────────────────
export const deleteModel = async (modelID) => {
  const modelDoc = await db.collection("model").doc(modelID).get();
  if (!modelDoc.exists) throw new Error("Model not found.");
  await db.collection("model").doc(modelID).delete();
  return { id: modelID, deleted: true };
};
