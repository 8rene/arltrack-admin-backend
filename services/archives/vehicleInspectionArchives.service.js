// vehicleInspectionArchives -- the four live inspection collections of a booking, kept together:
//   inventoryBeforeTrip, inventoryAfterTrip (part condition) and
//   vehicleDocumentationBeforeTrip, vehicleDocumentationAfterTrip (photos).
//
// One archive document per booking: { vehicleInspectionArchivesId (= bookingID), bookingID, carID, records: [...] }
// where every record is { collection, id, data } -- the exact live document (id and every field, including the dynamic
// part-photo fields) so a restore puts it back byte for byte. The photo URLs inside keep pointing at Firebase Storage;
// the files are never moved, so a restored inspection shows its photos again. The files are deleted only by a permanent
// delete (see utils/storage/storageFiles.js).
//
// A booking with no inspection records gets no archive document.
import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { uniq, chunk } from "./linkedArchives.service.js";
import { collectStorageUrls, deleteStorageFiles } from "../../utils/storage/storageFiles.js";
import { syncCarPartConditions } from "../carParts/carPartConditions.service.js";

export const INSPECTION_COLLECTIONS = [
  "inventoryBeforeTrip",
  "inventoryAfterTrip",
  "vehicleDocumentationBeforeTrip",
  "vehicleDocumentationAfterTrip",
];
const ARCHIVE = "vehicleInspectionArchives";
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);
const millis = (val) => (val?.toDate ? val.toDate().getTime() : val ? new Date(val).getTime() || 0 : 0);

// live inspection docs of a booking, found by every key the booking is known by
export const collectInspectionForBooking = async ({ bookingKeys }) => {
  const docs = new Map();
  for (const name of INSPECTION_COLLECTIONS) {
    for (const part of chunk(uniq(bookingKeys), 30)) {
      (await db.collection(name).where("bookingID", "in", part).get()).docs.forEach((d) => docs.set(`${name}/${d.id}`, { name, doc: d }));
    }
  }
  return [...docs.values()];
};
export const inspectionLiveRefs = (rows = []) => rows.map((r) => r.doc.ref);

// ── DELETE side: one archive doc per booking, written before anything live is deleted
export const writeInspectionArchive = async (rows = [], { bookingID, archivedBy = "admin" } = {}) => {
  if (!rows.length) return 0;
  const first = rows.map((r) => r.doc.data()).find((d) => d.carID);
  const records = rows.map((r) => ({ collection: r.name, id: r.doc.id, data: r.doc.data() }));
  await db.collection(ARCHIVE).doc(bookingID).set({
    vehicleInspectionArchivesId: bookingID,
    originalId: bookingID,
    bookingID,
    carID: first?.carID || null,
    records,
    archiveDate: stamp(),
    archivedAt: stamp(),
    archivedBy,
  });
  return rows.length;
};

// ── RESTORE
const putBack = async (snap) => {
  const { records = [] } = snap.data();
  for (const part of chunk(records, 200)) {
    const batch = db.batch();
    part.forEach((r) => batch.set(db.collection(r.collection).doc(r.id), stripArchiveMeta(r.data)));
    await batch.commit();
  }
  await snap.ref.delete();
  // Restored inspection records can change which parts are damaged -> refresh the car's live part condition.
  await syncCarPartConditions(snap.data().carID, records.map((r) => r.data?.carID));
  return records.length;
};

/** Restoring a booking brings its inspection records back. */
export const restoreInspectionArchiveForBooking = async ({ bookingKeys }) => {
  let restored = 0;
  for (const key of uniq(bookingKeys)) {
    const snap = await db.collection(ARCHIVE).doc(String(key)).get();
    if (snap.exists) restored += await putBack(snap);
  }
  return restored;
};

/** Restoring one record on its own (Vehicle Inspection Archive page). */
export const restoreInspectionArchive = async (archiveID) => {
  const snap = await db.collection(ARCHIVE).doc(archiveID).get();
  if (!snap.exists) throw new Error("Archived vehicle inspection not found.");
  await putBack(snap);
};

// ── PERMANENT DELETE
export const getInspectionArchiveSnapsForBooking = async ({ bookingKeys }) => {
  const snaps = [];
  for (const key of uniq(bookingKeys)) {
    const snap = await db.collection(ARCHIVE).doc(String(key)).get();
    if (snap.exists) snaps.push(snap);
  }
  return snaps;
};
export const getInspectionArchiveRefsForBooking = async ({ bookingKeys }) => (await getInspectionArchiveSnapsForBooking({ bookingKeys })).map((s) => s.ref);

// every Storage URL inside archive docs and/or live inspection docs: these files go with a permanent delete
export const inspectionFileUrls = ({ archiveSnaps = [], liveDocs = [] }) => {
  const urls = new Set();
  archiveSnaps.forEach((s) => (s.data().records || []).forEach((r) => collectStorageUrls(r.data, urls)));
  liveDocs.forEach((d) => collectStorageUrls(d.data(), urls));
  return urls;
};
export const removeInspectionFiles = (urls) => deleteStorageFiles(urls);

export const deleteInspectionArchive = async (archiveID) => {
  const ref = db.collection(ARCHIVE).doc(archiveID);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Archived vehicle inspection not found.");
  const files = inspectionFileUrls({ archiveSnaps: [snap] });
  await ref.delete();
  return { files: await removeInspectionFiles(files) };
};

// ── what the "View Vehicle Inspection" window shows (shaped like getInspectionRecordsForBooking)
export const shapeInspectionRecords = (records = []) => {
  const out = Object.fromEntries(INSPECTION_COLLECTIONS.map((c) => [c, []]));
  records.forEach((r) => {
    if (!out[r.collection]) return;
    const clean = Object.fromEntries(Object.entries(r.data || {}).map(([k, v]) => [k, toISO(v)]));
    out[r.collection].push({ id: r.id, ...clean });
  });
  return out;
};
export const getArchivedInspectionForBooking = async (bookingID) => {
  const snap = await db.collection(ARCHIVE).doc(String(bookingID)).get();
  return snap.exists ? shapeInspectionRecords(snap.data().records) : null;
};

// ── LIST (newest archived first; sorted here so no Firestore index is needed)
export const getAllInspectionArchives = async () => {
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
      const shaped = shapeInspectionRecords(data.records);
      const damaged = (c) => shaped[c].reduce((n, r) => n + (Array.isArray(r.damageParts) ? r.damageParts.length : 0), 0);
      const photos = (c) => shaped[c].reduce((n, r) => n + Object.keys(r).filter((k) => /Url$/.test(k) && r[k]).length, 0);
      return {
        vehicleInspectionArchivesId: d.id,
        bookingID: data.bookingID,
        carID: data.carID,
        plateNumber: car?.plateNumber || "—",
        brandName: car ? brandMap[car.brandID] || "—" : "—",
        modelName: car ? modelMap[car.modelID] || "—" : "—",
        recordCount: (data.records || []).length,
        beforeDamaged: damaged("inventoryBeforeTrip"),
        afterDamaged: damaged("inventoryAfterTrip"),
        beforePhotos: photos("vehicleDocumentationBeforeTrip"),
        afterPhotos: photos("vehicleDocumentationAfterTrip"),
        archivedAt: toISO(data.archivedAt),
        archivedBy: data.archivedBy || null,
        records: shaped,
      };
    });
};
