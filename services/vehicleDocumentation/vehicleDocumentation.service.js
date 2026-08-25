import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { partNameToFieldKey } from "../../models/vehicleDocumentation/vehicleDocumentation.model.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";

const DOC_COLLECTIONS = {
  before: "vehicleDocumentationBeforeTrip",
  after:  "vehicleDocumentationAfterTrip",
};

/**
 * Admin-only: replace (or add) a single photo on a past trip's
 * documentation record. `fieldKey` is either an exterior slot
 * ("frontViewUrl"/"sideViewUrl"/"backViewUrl") or a per-part field key
 * from getPartFieldKey (frontend) / resolvePartFieldKeys (backend).
 *
 * Upserts by bookingID, same reasoning as adminUpdateHistoryPartStatus —
 * covers both "replace an existing photo" and "no documentation record
 * exists yet for this trip" in one path. The actual file upload happens
 * client-side straight to Firebase Storage (same as the driver-flow
 * upload); this just points the record's field at the new URL and logs
 * the change with the previous URL for anyone tracing it back later.
 */
export const adminReplaceHistoryPhoto = async ({ tripPhase, bookingID, carID, fieldKey, newUrl, editedBy }) => {
  const collectionName = DOC_COLLECTIONS[tripPhase];
  if (!collectionName) throw new Error('tripPhase must be "before" or "after".');
  if (!bookingID || !fieldKey || !newUrl) {
    throw new Error("bookingID, fieldKey, and newUrl are required.");
  }

  const existingSnap = await db.collection(collectionName).where("bookingID", "==", bookingID).limit(1).get();
  const isNewRecord = existingSnap.empty;
  const now = admin.firestore.FieldValue.serverTimestamp();
  let ref, previousUrl;

  if (isNewRecord) {
    if (!carID) throw new Error("carID is required to create a new documentation record.");
    ref = db.collection(collectionName).doc();
    previousUrl = null;
    await ref.set({
      bookingID, carID, [fieldKey]: newUrl,
      recordedAt: now, lastEditedAt: now, lastEditedBy: editedBy || null,
      createdByAdmin: true,
    });
  } else {
    ref = existingSnap.docs[0].ref;
    previousUrl = existingSnap.docs[0].data()[fieldKey] || null;
    await ref.update({ [fieldKey]: newUrl, lastEditedAt: now, lastEditedBy: editedBy || null });
  }

  await createAuditLog({
    action: "update",
    description: isNewRecord
      ? `Vehicle inspection photo added by admin (${tripPhase} trip, booking ${bookingID} — no documentation record existed): "${fieldKey}" set.`
      : `Vehicle inspection photo replaced (${tripPhase} trip, booking ${bookingID}): "${fieldKey}" changed.${previousUrl ? ` Previous photo: ${previousUrl}` : " (no previous photo)"}`,
    userID: editedBy || null,
  });

  return { previousUrl, newUrl, recordID: ref.id, isNewRecord };
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Fetch all parts for a car and return an array of their URL field keys.
 * Uses carParts collection; resolves the display name via carPartTypes.
 * Each key is camelCase + "Url", e.g. "leftMirrorUrl".
 */
export const resolvePartFieldKeys = async (carID) => {
  if (!carID) return [];
  try {
    const [partsSnap, typesSnap] = await Promise.all([
      db.collection("carParts").where("carID", "==", carID).get(),
      db.collection("carPartTypes").get(),
    ]);

    const typeMap = {};
    typesSnap.docs.forEach((d) => {
      typeMap[d.id] = d.data().carPartName || "";
    });

    return partsSnap.docs.map((d) => {
      const part = d.data();
      // Combine type name + part name for a unique, descriptive key
      const typeName = typeMap[part.carPartTypeID] || "";
      const combined = `${typeName} ${part.carPartName || ""}`.trim();
      return partNameToFieldKey(combined) || partNameToFieldKey(part.carPartName || d.id);
    });
  } catch {
    return [];
  }
};

/**
 * Pick the latest document from a snapshot (sorted by updatedAt → createdAt).
 */
const pickLatest = (snap) => {
  if (snap.empty) return null;
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  docs.sort((a, b) => {
    const ta = a.updatedAt?._seconds ?? a.createdAt?._seconds ?? 0;
    const tb = b.updatedAt?._seconds ?? b.createdAt?._seconds ?? 0;
    return tb - ta;
  });
  return docs[0];
};

// ─────────────────────────────────────────────
// GET — fetch before + after docs for a booking
// ─────────────────────────────────────────────
export const getVehicleDocsByBooking = async (bookingID) => {
  const [beforeSnap, afterSnap] = await Promise.all([
    db.collection("vehicleDocumentationBeforeTrip").where("bookingID", "==", bookingID).get(),
    db.collection("vehicleDocumentationAfterTrip").where("bookingID", "==", bookingID).get(),
  ]);
  return {
    before: pickLatest(beforeSnap),
    after:  pickLatest(afterSnap),
  };
};

// ─────────────────────────────────────────────
// Gate used by booking.service.js before a booking can move to "ongoing"
// (i.e. Pickup). Only the 3 exterior shots are required — matches
// VehicleDocs.jsx, where part photos are shown but never marked Required.
// ─────────────────────────────────────────────
export const hasCompleteBeforeTripDocs = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db.collection("vehicleDocumentationBeforeTrip").where("bookingID", "==", bookingID).get();
  const doc = pickLatest(snap);
  if (!doc) return false;
  return !!(doc.frontViewUrl && doc.sideViewUrl && doc.backViewUrl);
};

/**
 * Same check as hasCompleteBeforeTripDocs, but for the after-trip photo
 * set — used to gate the "completed" (Return) transition the same way
 * before-trip docs gate "ongoing" (Pickup).
 */
export const hasCompleteAfterTripDocs = async (bookingID) => {
  if (!bookingID) return false;
  const snap = await db.collection("vehicleDocumentationAfterTrip").where("bookingID", "==", bookingID).get();
  const doc = pickLatest(snap);
  if (!doc) return false;
  return !!(doc.frontViewUrl && doc.sideViewUrl && doc.backViewUrl);
};

// ─────────────────────────────────────────────
// SAVE / UPSERT — Before Trip Documentation
// ─────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.bookingID
 * @param {string} params.carID
 * @param {object} params.photoFields  — { frontViewUrl, sideViewUrl, backViewUrl, leftMirrorUrl, … }
 */
export const saveVehicleDocBefore = async ({ bookingID, carID, photoFields }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");

  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  const existingSnap = await db
    .collection("vehicleDocumentationBeforeTrip")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  let docID;

  if (!existingSnap.empty) {
    docID = existingSnap.docs[0].id;
    await existingSnap.docs[0].ref.update({
      ...photoFields,
      updatedAt: timestamp,
    });
  } else {
    const newRef = await db.collection("vehicleDocumentationBeforeTrip").add({
      bookingID,
      carID,
      vehicleDocumentationBeforeTripID: "", // will be back-filled below
      frontViewUrl: "",
      sideViewUrl:  "",
      backViewUrl:  "",
      ...photoFields,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    docID = newRef.id;
    // Back-fill the ID field so it mirrors the Firestore doc ID
    await newRef.update({ vehicleDocumentationBeforeTripID: docID });
  }

  return { success: true, vehicleDocumentationBeforeTripID: docID };
};

// ─────────────────────────────────────────────
// SAVE / UPSERT — After Trip Documentation
// ─────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.bookingID
 * @param {string} params.carID
 * @param {object} params.photoFields  — { frontViewUrl, sideViewUrl, backViewUrl, leftMirrorUrl, … }
 */
export const saveVehicleDocAfter = async ({ bookingID, carID, photoFields }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");

  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  const existingSnap = await db
    .collection("vehicleDocumentationAfterTrip")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  let docID;

  if (!existingSnap.empty) {
    docID = existingSnap.docs[0].id;
    await existingSnap.docs[0].ref.update({
      ...photoFields,
      updatedAt: timestamp,
    });
  } else {
    const newRef = await db.collection("vehicleDocumentationAfterTrip").add({
      bookingID,
      carID,
      vehicleDocumentationAfterTripID: "", // will be back-filled below
      frontViewUrl: "", 
      sideViewUrl:  "",
      backViewUrl:  "",
      ...photoFields,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    docID = newRef.id;
    await newRef.update({ vehicleDocumentationAfterTripID: docID });
  }

  return { success: true, vehicleDocumentationAfterTripID: docID };
};

// ─────────────────────────────────────────────
// SAVE / UPSERT — Inventory status (Good/Damaged part flags)
// Separate collections from the photo docs above (inventoryBeforeTrip /
// inventoryAfterTrip vs vehicleDocumentationBeforeTrip / …AfterTrip) —
// same upsert-by-bookingID pattern, just a different pair of collections.
// damageParts/overallStatus arrive already computed (merged against the
// previous record) from VehicleDocs.jsx's commitStatusEdits — this only
// moves the write itself, same as everywhere else in this migration.
// ─────────────────────────────────────────────
const INVENTORY_COLLECTION = {
  before: "inventoryBeforeTrip",
  after:  "inventoryAfterTrip",
};

export const saveInventoryStatus = async ({ bookingID, carID, tripType, overallStatus, damageParts }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");
  if (tripType !== "before" && tripType !== "after") throw new Error("tripType must be 'before' or 'after'.");

  const collectionName = INVENTORY_COLLECTION[tripType];
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  const existingSnap = await db
    .collection(collectionName)
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();

  let docID;
  if (!existingSnap.empty) {
    docID = existingSnap.docs[0].id;
    await existingSnap.docs[0].ref.update({
      inventoryOverallStatus: overallStatus,
      damageParts,
      recordedAt: timestamp,
    });
  } else {
    const newRef = await db.collection(collectionName).add({
      bookingID,
      carID,
      inventoryOverallStatus: overallStatus,
      damageParts,
      recordedAt: timestamp,
    });
    docID = newRef.id;
  }

  return { success: true, id: docID };
};