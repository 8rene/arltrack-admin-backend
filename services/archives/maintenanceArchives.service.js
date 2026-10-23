// maintenanceArchives -- the booking-linked rows of the live `maintenance` collection (bookingID set: post-rental jobs
// created from a booking's detail view; routine maintenance has bookingID null and is never archived).
//
// An archive doc is a COPY of the live doc plus the bookkeeping in archiveMeta.js, and its id IS the live maintenance
// id (a penalty's maintenanceID points at it; re-archiving overwrites instead of duplicating). A restored record gets
// no restoredAt: the live maintenance model has no such column. Unlike the linked archives, maintenance has its own
// Maintenance Archive page (list, restore, permanent delete).
import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { uniq, chunk } from "./linkedArchives.service.js";
import { syncCarPartConditions } from "../carParts/carPartConditions.service.js";

const LIVE = "maintenance";
const ARCHIVE = "maintenanceArchives";
const BATCH_WRITES = 400;
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);
const millis = (val) => (val?.toDate ? val.toDate().getTime() : val ? new Date(val).getTime() || 0 : 0);

// every doc of `collection` whose bookingID is one of `bookingKeys` (its bookingID field AND its doc id)
const byBooking = async (collection, bookingKeys) => {
  const docs = new Map();
  for (const part of chunk(uniq(bookingKeys), 30)) {
    (await db.collection(collection).where("bookingID", "in", part).get()).docs.forEach((d) => docs.set(d.id, d));
  }
  return [...docs.values()];
};

// ── DELETE side (booking deleted): live rows of this booking, any status; copies written first, nothing deleted here
export const collectMaintenanceForBooking = ({ bookingKeys }) => byBooking(LIVE, bookingKeys);
export const maintenanceLiveRefs = (docs = []) => docs.map((d) => d.ref);

export const writeMaintenanceArchives = async (docs = [], archivedBy = "admin") => {
  for (const part of chunk(docs, BATCH_WRITES)) {
    const batch = db.batch();
    part.forEach((d) => batch.set(db.collection(ARCHIVE).doc(d.id), {
      maintenanceArchivesID: d.id, originalId: d.id, archiveDate: stamp(), archivedAt: stamp(), archivedBy, ...d.data(),
    }));
    await batch.commit();
  }
  return docs.length;
};

// ── RESTORE
const putBack = async (docs) => {
  for (const part of chunk(docs, BATCH_WRITES / 2)) {
    const batch = db.batch();
    part.forEach((d) => {
      batch.set(db.collection(LIVE).doc(d.data().originalId || d.id), stripArchiveMeta(d.data()));
      batch.delete(d.ref);
    });
    await batch.commit();
  }
  // Restored jobs can fix (or re-flag) parts -> refresh those cars' live part condition (carParts.status).
  await syncCarPartConditions(docs.map((d) => d.data().carID));
  return docs.length;
};

/** Restoring a booking brings all of its maintenance archives back. */
export const restoreMaintenanceArchivesForBooking = async ({ bookingKeys }) => putBack(await byBooking(ARCHIVE, bookingKeys));

/** Restoring one record on its own. Reports whether its booking is still archived. */
export const restoreMaintenanceArchive = async (archiveID) => {
  const snap = await db.collection(ARCHIVE).doc(archiveID).get();
  if (!snap.exists) throw new Error("Archived maintenance record not found.");
  const { bookingID } = snap.data();
  await putBack([snap]);
  const booking = bookingID ? await db.collection("bookingArchives").where("bookingID", "==", bookingID).limit(1).get() : null;
  return { bookingStillArchived: Boolean(booking && !booking.empty) };
};

// ── PERMANENT DELETE
export const getMaintenanceArchiveRefsForBooking = async ({ bookingKeys }) => (await byBooking(ARCHIVE, bookingKeys)).map((d) => d.ref);

export const deleteMaintenanceArchive = async (archiveID) => {
  const ref = db.collection(ARCHIVE).doc(archiveID);
  if (!(await ref.get()).exists) throw new Error("Archived maintenance record not found.");
  await ref.delete();
};

// ── LIST (newest archived first; sorted here so no Firestore index is needed) + the car's plate / brand / model,
// read the same way maintenance.service.js's getAllMaintenance does
export const getAllMaintenanceArchives = async () => {
  const snap = await db.collection(ARCHIVE).get();
  if (snap.empty) return [];
  const [cars, brands, models] = await Promise.all(["cars", "brand", "model"].map((c) => db.collection(c).get()));
  const carMap = Object.fromEntries(cars.docs.map((d) => [d.id, d.data()]));
  const brandMap = Object.fromEntries(brands.docs.map((d) => [d.id, d.data().brandName]));
  const modelMap = Object.fromEntries(models.docs.map((d) => [d.id, d.data().modelName]));

  return snap.docs
    .sort((a, b) => millis(b.data().archivedAt) - millis(a.data().archivedAt))
    .map((d) => {
      const data = d.data();
      const car = carMap[data.carID];
      const out = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toISO(v)]));
      return {
        ...out,
        maintenanceArchivesId: d.id,
        plateNumber: car?.plateNumber || "—",
        brandName: car ? brandMap[car.brandID] || "—" : "—",
        modelName: car ? modelMap[car.modelID] || "—" : "—",
      };
    });
};