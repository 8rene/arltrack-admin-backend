import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  partNameToFieldKey,
  INSPECTION_MEDIA,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MAX_EXTRA_PHOTO_BYTES,
} from "../../models/vehicleDocumentation/vehicleDocumentation.model.js";
import { storagePathFromUrl, deleteStorageFiles } from "../../utils/storage/storageFiles.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { createNotification } from "../notification/notification.service.js";
import { resolveCurrentDriverID } from "../driverAssignments/driverAssignments.service.js";
import { syncCarPartConditions } from "../carParts/carPartConditions.service.js";

const DOC_COLLECTIONS = {
  before: "vehicleDocumentationBeforeTrip",
  after:  "vehicleDocumentationAfterTrip",
};

// The Good/Damaged part-condition records — separate collections from the
// photo docs above, same upsert-by-bookingID pattern.
const INVENTORY_COLLECTION = {
  before: "inventoryBeforeTrip",
  after:  "inventoryAfterTrip",
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

/**
 * Fold EVERY photo doc for a booking into one record (oldest → newest, so a
 * newer non-empty URL wins). Older saves created one doc per photo slot (see
 * the note in VechicleInspection.jsx's Save All); picking only the latest doc
 * then looked like "only one photo uploaded" and the inspection never counted
 * as complete. Merging makes both the old split data and the new single-doc
 * data read the same.
 */
const mergeDocs = (snap) => {
  if (snap.empty) return null;
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  docs.sort((a, b) => {
    const ta = a.updatedAt?._seconds ?? a.createdAt?._seconds ?? 0;
    const tb = b.updatedAt?._seconds ?? b.createdAt?._seconds ?? 0;
    return ta - tb;
  });
  const merged = {};
  docs.forEach((d) => {
    Object.entries(d).forEach(([k, v]) => {
      // videos / extraPhotos: combine across docs (by item id) rather than letting the newest doc's list replace the others
      if (Array.isArray(v)) {
        if (!v.length) return;
        const keyOf = (i) => i?.url || i?.id;
        const seen = new Set((merged[k] || []).map(keyOf));
        merged[k] = [...(merged[k] || []), ...v.filter((i) => !seen.has(keyOf(i)))];
        return;
      }
      if (v !== "" && v !== null && v !== undefined) merged[k] = v;
    });
  });
  merged.id = docs[docs.length - 1].id; // keep the latest doc's id
  return merged;
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
    before: mergeDocs(beforeSnap),
    after:  mergeDocs(afterSnap),
  };
};

// ─────────────────────────────────────────────
// Inspection checklist — the gate behind Pickup and Return.
//
// A phase ("before" = Pickup, "after" = Return) counts as inspected only
// when BOTH of these exist for the booking:
//   photos — EITHER the 3 exterior shots (front/side/back) OR at least one
//            inspection video. A video can stand in for the three photos
//            (one walkaround covers every side). Part photos and extra
//            photos are allowed too but never required.
//   parts  — a saved part-condition record (inventoryBeforeTrip /
//            inventoryAfterTrip, the Good/Damaged flags). Even an
//            all-Good car needs the record: staff must explicitly confirm
//            the parts, it is never assumed.
//
// Drivers can't write either half anymore (vehicleDocumentation.routes.js),
// so "complete" always means a supervisor/admin/owner did the inspection.
// ─────────────────────────────────────────────
const exteriorComplete = (doc) => !!(doc && doc.frontViewUrl && doc.sideViewUrl && doc.backViewUrl);
const videoCount = (doc) => (Array.isArray(doc?.videos) ? doc.videos.length : 0);
const photosComplete = (doc) => exteriorComplete(doc) || videoCount(doc) > 0;

/** { photos, parts, complete } for one phase of one booking. */
// `bookingID` may be one key or an array of keys (the booking's business
// bookingID AND its Firestore doc id) — records saved under either one count.
export const getPhaseChecklist = async (bookingID, phase) => {
  const empty = { photos: false, parts: false, complete: false, videos: 0, photoSlots: { front: false, side: false, back: false } };
  const keys = [...new Set([].concat(bookingID).filter(Boolean))].slice(0, 10);
  if (!keys.length || !DOC_COLLECTIONS[phase]) return empty;

  const byKey = (col) => (keys.length === 1 ? col.where("bookingID", "==", keys[0]) : col.where("bookingID", "in", keys));

  const [docsSnap, invSnap] = await Promise.all([
    byKey(db.collection(DOC_COLLECTIONS[phase])).get(),
    byKey(db.collection(INVENTORY_COLLECTION[phase])).limit(1).get(),
  ]);

  const doc = mergeDocs(docsSnap);
  const photoSlots = { front: !!doc?.frontViewUrl, side: !!doc?.sideViewUrl, back: !!doc?.backViewUrl };
  const videos = videoCount(doc);
  const photos = photosComplete(doc); // true via the 3 exterior photos OR a video
  const parts  = !invSnap.empty;
  return { photos, parts, complete: photos && parts, videos, photoSlots };
};

/** Both phases at once — { before, after }, each { photos, parts, complete }. */
export const getInspectionChecklist = async (bookingID) => {
  const [before, after] = await Promise.all([
    getPhaseChecklist(bookingID, "before"),
    getPhaseChecklist(bookingID, "after"),
  ]);
  return { before, after };
};

/** Human-readable list of what's still missing, e.g. "front, side and back photos and parts condition". */
export const describeMissingInspection = (checklist) => {
  const missing = [];
  if (!checklist?.photos) missing.push("a video or the front, side and back photos");
  if (!checklist?.parts)  missing.push("parts condition");
  return missing.join(" and ");
};

// Gate used by booking.service.js before a booking can move to "ongoing"
// (Pickup). Kept as a thin wrapper so existing callers keep working — but
// it now includes the parts record, not just the photos.
export const hasCompleteBeforeTripDocs = async (bookingID) =>
  (await getPhaseChecklist(bookingID, "before")).complete;

/**
 * Same check for the after-trip set — gates the "completed" (Return)
 * transition the same way the before-trip set gates "ongoing" (Pickup).
 */
export const hasCompleteAfterTripDocs = async (bookingID) =>
  (await getPhaseChecklist(bookingID, "after")).complete;

// videos / extraPhotos are arrays that grow and shrink; they are changed ONLY through
// addInspectionMedia / removeInspectionMedia below (atomic, capped, validated). If they
// came in through the generic photoFields save, an update() would overwrite the whole array.
const stripMediaFields = (fields = {}) => {
  const { videos, extraPhotos, ...rest } = fields || {};
  return rest;
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
export const saveVehicleDocBefore = async ({ bookingID, carID, photoFields: rawPhotoFields }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");
  const photoFields = stripMediaFields(rawPhotoFields);

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
export const saveVehicleDocAfter = async ({ bookingID, carID, photoFields: rawPhotoFields }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");
  const photoFields = stripMediaFields(rawPhotoFields);

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
export const saveInventoryStatus = async ({ bookingID, carID, tripType, overallStatus, damageParts }) => {
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");
  if (tripType !== "before" && tripType !== "after") throw new Error("tripType must be 'before' or 'after'.");

  // Hard rule: the parts condition can't be saved for a trip phase that has neither a video nor the 3 exterior
  // photos yet — an inspection is never recorded "with nothing". (The page enforces this too; this is the backstop.)
  const evidence = await getPhaseChecklist(bookingID, tripType);
  if (!evidence.photos) {
    const err = new Error("Add a video (or the front, side and back photos) before saving the parts condition.");
    err.status = 400;
    throw err;
  }

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

  // The saved parts may be in a different condition than before -> update the car parts' live status.
  await syncCarPartConditions(carID);

  return { success: true, id: docID };
};

// ---------------------------------------------
// Staff confirm that the car (exterior) and the car parts were checked and are in the condition recorded for this
// phase. Needs the same two things the pickup / return gate needs (a video or the 3 exterior photos, and a saved
// parts record). Stamps the phase record and notifies the assigned driver, or the customer when there is no driver. Once per phase: a second press is refused, so the
// customer is never notified twice for the same inspection.
// ---------------------------------------------
const findBookingByKey = async (key) => {
  const byField = await db.collection("bookings").where("bookingID", "==", key).limit(1).get();
  if (!byField.empty) return { id: byField.docs[0].id, ...byField.docs[0].data() };
  const byID = await db.collection("bookings").doc(String(key)).get();
  return byID.exists ? { id: byID.id, ...byID.data() } : null;
};

export const confirmInspection = async ({ phase, bookingID, carID, confirmedBy }) => {
  const collectionName = DOC_COLLECTIONS[phase];
  if (!collectionName) { const e = new Error('phase must be "before" or "after".'); e.status = 400; throw e; }
  if (!bookingID) { const e = new Error("bookingID is required."); e.status = 400; throw e; }

  const checklist = await getPhaseChecklist(bookingID, phase);
  if (!checklist.complete) {
    const e = new Error(`Can't confirm yet: still needed ${describeMissingInspection(checklist)}.`);
    e.status = 400;
    throw e;
  }

  const docsSnap = await db.collection(collectionName).where("bookingID", "==", bookingID).get();
  if (docsSnap.empty) { const e = new Error("There is no inspection record to confirm yet."); e.status = 400; throw e; }
  if (docsSnap.docs.some((d) => d.data().inspectionConfirmed)) {
    const e = new Error("This inspection was already confirmed.");
    e.status = 409;
    throw e;
  }

  const invSnap = await db.collection(INVENTORY_COLLECTION[phase]).where("bookingID", "==", bookingID).limit(1).get();
  const damageParts = invSnap.empty ? [] : (Array.isArray(invSnap.docs[0].data().damageParts) ? invSnap.docs[0].data().damageParts : []);

  const latest = pickLatest(docsSnap);
  const confirmedAt = new Date();
  await db.collection(collectionName).doc(latest.id).update({
    inspectionConfirmed: { at: confirmedAt, by: confirmedBy || null, damagedPartCount: damageParts.length },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Tell whoever is handling the car on this trip. When a driver is assigned, ONLY the driver is told; the customer
  // is notified only when there is no driver (self-drive, or a chauffeur booking with nobody assigned yet).
  // A notification problem never undoes the confirmation.
  let notifiedTo = null;   // "driver" | "customer" | null
  try {
    const booking = await findBookingByKey(bookingID);
    if (booking) {
      const before = phase === "before";
      const bookingRef = booking.bookingID || bookingID;
      const driverID = await resolveCurrentDriverID(booking, booking.id);
      const note = damageParts.length > 0 ? " Some condition notes were recorded." : " Everything was recorded in good condition.";
      const extra = { carID: carID || booking.carID || null, phase };
      if (driverID) {
        await createNotification({
          type: "inspection_confirmed",
          refID: booking.id,                 // same reference the driver_assigned notification uses
          refCollection: "bookings",
          userID: driverID,
          dedupeKey: phase,
          title: before ? "Car inspected - ready for pickup" : "Return inspection confirmed",
          message: (before
            ? `The car for booking ${bookingRef} was checked and its condition confirmed. You can go ahead with the pickup.`
            : `The car for booking ${bookingRef} was checked after the trip and its condition confirmed.`) + note,
          extra,
        });
        notifiedTo = "driver";
      } else if (booking.userID) {
        await createNotification({
          type: "inspection_confirmed",
          refID: bookingRef,
          refCollection: "bookings",
          userID: booking.userID,
          dedupeKey: phase,
          title: before ? "Your rental car was checked before pickup" : "Your rental car was checked after return",
          message: (before
            ? "Our team checked the car's exterior and all of its parts and confirmed their condition before pickup."
            : "Our team checked the car's exterior and all of its parts and confirmed their condition after your trip.")
            + note + ` Booking ${bookingRef}.`,
          extra,
        });
        notifiedTo = "customer";
      }
    }
  } catch (err) {
    console.error("[VEHICLE_DOCS] could not send the inspection-confirmed notification:", err.message);
  }
  if (notifiedTo) {
    await db.collection(collectionName).doc(latest.id).update({ "inspectionConfirmed.notifiedTo": notifiedTo })
      .catch((err) => console.error("[VEHICLE_DOCS] could not record who was notified:", err.message));
  }

  await createAuditLog({
    action: "update",
    description: `Confirmed the ${phase}-trip inspection of booking ${bookingID} (${damageParts.length} part(s) flagged).${notifiedTo ? ` ${notifiedTo === "driver" ? "Driver" : "Customer"} notified.` : " Nobody was notified (no driver or customer found)."}`,
    userID: confirmedBy || null,
  }).catch((err) => console.error("[VEHICLE_DOCS] audit log failed:", err.message));

  return { confirmedAt, notified: !!notifiedTo, notifiedTo, damagedPartCount: damageParts.length };
};

// ─────────────────────────────────────────────
// GET — read-only before/after inventory condition summary for one
// booking. Same inventoryBeforeTrip/inventoryAfterTrip collections
// saveInventoryStatus writes to; used by the driver-facing My Trips
// history view, which only needs the overall status + any damaged parts,
// not the full photo set (see getVehicleDocsByBooking for that).
// ─────────────────────────────────────────────
const pickLatestByRecordedAt = (snap) => {
  if (snap.empty) return null;
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  docs.sort((a, b) => (b.recordedAt?._seconds ?? 0) - (a.recordedAt?._seconds ?? 0));
  return docs[0];
};

export const getInventorySummaryByBooking = async (bookingID) => {
  if (!bookingID) return { before: null, after: null };
  const [beforeSnap, afterSnap] = await Promise.all([
    db.collection(INVENTORY_COLLECTION.before).where("bookingID", "==", bookingID).get(),
    db.collection(INVENTORY_COLLECTION.after).where("bookingID", "==", bookingID).get(),
  ]);
  const shape = (doc) => doc && {
    overallStatus: doc.inventoryOverallStatus || null,
    damageParts:   doc.damageParts || [],
    recordedAt:    doc.recordedAt || null,
  };
  return {
    before: shape(pickLatestByRecordedAt(beforeSnap)),
    after:  shape(pickLatestByRecordedAt(afterSnap)),
  };
};

// ─────────────────────────────────────────────
// Videos & additional photos (optional, free-form)
//
// The browser uploads the file straight to Firebase Storage under
//   vehicleDocs/{carID}/{bookingID}/{phase}/...
// and then tells us the URL. We never see the file itself.
//
// Both operations run in a transaction so two staff members adding at the
// same moment can't push the list past its cap, and a remove can't lose
// somebody else's concurrent add.
// ─────────────────────────────────────────────
const mediaConfig = (kind) => {
  const cfg = INSPECTION_MEDIA[kind];
  if (!cfg) throw new Error('kind must be "videos" or "extraPhotos".');
  return cfg;
};

const cleanNumber = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : null);

/**
 * Add one video or additional photo to a booking's before/after record.
 * Creates the record if none exists yet (same shape saveVehicleDocBefore/After create).
 */
export const addInspectionMedia = async ({ phase, kind, bookingID, carID, url, durationSec, sizeBytes, mimeType, addedBy, caption }) => {
  const collectionName = DOC_COLLECTIONS[phase];
  if (!collectionName) throw new Error('phase must be "before" or "after".');
  const { field, max, label } = mediaConfig(kind);
  if (!bookingID || !carID) throw new Error("bookingID and carID are required.");
  if (!url) throw new Error("url is required.");

  // The URL must be a file in OUR bucket, inside this booking's folder for this phase.
  const path = storagePathFromUrl(url);
  if (!path) throw new Error("url must be a Firebase Storage file in this project.");
  if (!path.startsWith("vehicleDocs/") || !path.includes(`/${bookingID}/${phase}/`)) {
    throw new Error("The uploaded file is not in this booking's inspection folder.");
  }

  const size = cleanNumber(sizeBytes);
  const type = String(mimeType || "");
  const item = { url };   // all that is stored: the link (+ an optional caption on additional photos)

  if (kind === "videos") {
    if (!type.startsWith("video/")) throw new Error("That file is not a video.");
    if (size && size > MAX_VIDEO_BYTES) throw new Error(`Video is too large (max ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB).`);
    const dur = cleanNumber(durationSec);
    if (dur && dur > MAX_VIDEO_SECONDS) throw new Error(`Video is too long (max ${MAX_VIDEO_SECONDS / 60} minutes).`);
  } else {
    if (!type.startsWith("image/")) throw new Error("That file is not an image.");
    if (size && size > MAX_EXTRA_PHOTO_BYTES) throw new Error(`Photo is too large (max ${Math.round(MAX_EXTRA_PHOTO_BYTES / 1048576)} MB).`);
    // Optional label ("Front bumper", "Left mirror" ...). A photo with no label is fine: it is just an additional photo.
    const label = String(caption || "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (label) item.caption = label;
  }

  const query = db.collection(collectionName).where("bookingID", "==", bookingID);
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    const current = snap.docs.reduce((n, d) => n + (Array.isArray(d.data()[field]) ? d.data()[field].length : 0), 0);
    // the url is what identifies an entry, so the same file can't be added twice
    if (snap.docs.some((d) => (Array.isArray(d.data()[field]) ? d.data()[field] : []).some((i) => i?.url === url))) {
      throw new Error(`That ${label} was already added.`);
    }
    if (current >= max) throw new Error(`Limit reached: at most ${max} ${label}s per inspection.`);

    if (!snap.empty) {
      tx.update(snap.docs[0].ref, { [field]: admin.firestore.FieldValue.arrayUnion(item), updatedAt: timestamp });
      return { recordID: snap.docs[0].id, isNewRecord: false, count: current + 1 };
    }
    const ref = db.collection(collectionName).doc();
    tx.set(ref, {
      bookingID,
      carID,
      [`${collectionName === DOC_COLLECTIONS.before ? "vehicleDocumentationBeforeTripID" : "vehicleDocumentationAfterTripID"}`]: ref.id,
      frontViewUrl: "",
      sideViewUrl: "",
      backViewUrl: "",
      [field]: [item],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return { recordID: ref.id, isNewRecord: true, count: 1 };
  });

  await createAuditLog({
    action: "update",
    description: `Added ${label} to the ${phase}-trip inspection of booking ${bookingID}.`,
    userID: addedBy || null,
  }).catch((err) => console.error("[VEHICLE_DOCS] audit log failed:", err.message));

  return { ...result, item };
};

/**
 * Remove one video or additional photo by its id, then delete the file from Storage
 * (best effort — a file that can't be deleted never blocks the record change).
 */
export const removeInspectionMedia = async ({ phase, kind, bookingID, url, removedBy }) => {
  const collectionName = DOC_COLLECTIONS[phase];
  if (!collectionName) throw new Error('phase must be "before" or "after".');
  const { field, label } = mediaConfig(kind);
  if (!bookingID || !url) throw new Error("bookingID and url are required.");

  const query = db.collection(collectionName).where("bookingID", "==", bookingID);

  const removed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(query);
    for (const d of snap.docs) {
      const list = Array.isArray(d.data()[field]) ? d.data()[field] : [];
      const hit = list.find((i) => i?.url === url);
      if (hit) {
        tx.update(d.ref, { [field]: list.filter((i) => i?.url !== url), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        return hit;
      }
    }
    return null;
  });
  if (!removed) throw new Error(`That ${label} was not found.`);

  const files = await deleteStorageFiles([removed.url]);
  await createAuditLog({
    action: "delete",
    description: `Removed ${label} from the ${phase}-trip inspection of booking ${bookingID} (${storagePathFromUrl(removed.url) || "file"}).`,
    userID: removedBy || null,
  }).catch((err) => console.error("[VEHICLE_DOCS] audit log failed:", err.message));

  return { removed: removed.url, files };
};