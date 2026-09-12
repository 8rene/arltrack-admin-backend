import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { BASIS_OPTIONS, STATUS_OPTIONS, SERVICE_CATALOG } from "../../models/maintenance/maintenance.model.js";
import { adminUpdateHistoryPartStatus } from "../inventory/inventory.service.js";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

// Converts a date string/Date from the request body into a real Firestore
// Timestamp, so downstream .toDate() calls (calendar view, sorting, isPast
// checks) work the same way they do for every other timestamp field in
// this app. Returns null for empty/invalid input.
const toFirestoreDate = (val) => {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d)) return null;
  return admin.firestore.Timestamp.fromDate(d);
};

// Flat lookup: serviceID -> serviceName, built from the grouped catalog
const SERVICE_LOOKUP = Object.fromEntries(
  SERVICE_CATALOG.flatMap((group) => group.services).map((s) => [s.serviceID, s.serviceName])
);

// Validates + normalizes the services[] array from a request body.
// Unknown serviceIDs are rejected unless they're explicitly marked custom
// (serviceID: "other"), which allows the frontend's free-text "Other" entry.
const normalizeServices = (services = []) => {
  if (!Array.isArray(services)) throw new Error("services must be an array.");

  return services.map((s) => {
    const price = Number(s.price) || 0;
    if (price < 0) throw new Error("Service price cannot be negative.");

    if (s.serviceID === "other") {
      if (!s.serviceName || !s.serviceName.trim()) {
        throw new Error("Custom services require a serviceName.");
      }
      return { serviceID: "other", serviceName: s.serviceName.trim(), price };
    }

    const knownName = SERVICE_LOOKUP[s.serviceID];
    if (!knownName) throw new Error(`Unknown serviceID: ${s.serviceID}`);

    return { serviceID: s.serviceID, serviceName: knownName, price };
  });
};

// Server-side total: sum of itemized services, unless overrideTotal is provided.
const computeTotal = (services, overrideTotal) => {
  if (overrideTotal !== undefined && overrideTotal !== null && overrideTotal !== "") {
    const total = Number(overrideTotal);
    if (total < 0) throw new Error("overrideTotal cannot be negative.");
    return total;
  }
  return services.reduce((sum, s) => sum + s.price, 0);
};

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const fmtDate = (d) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });

// Checks whether `carID` has an active booking (pending/approved — i.e. the
// car will actually be out) whose date range overlaps the given day.
// Returns the conflicting booking, or null.
const findBookingConflict = async (carID, dateVal) => {
  const d = toJSDate(dateVal);
  if (!carID || !d) return null;

  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
  const dayEnd   = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  const snap = await db
    .collection("bookings")
    .where("carID", "==", carID)
    .where("status", "in", ["pending", "approved"])
    .get();

  for (const bDoc of snap.docs) {
    const b = bDoc.data();
    const bStart = toJSDate(b.startDateTime);
    const bEnd   = toJSDate(b.endDateTime);
    if (!bStart || !bEnd) continue;
    if (dayStart <= bEnd && dayEnd >= bStart) {
      return { id: bDoc.id, ...b };
    }
  }
  return null;
};

// Runs the conflict check against both dates and throws a descriptive
// error naming the conflicting booking, so the save is blocked with a
// clear reason rather than silently failing.
const assertNoBookingConflict = async (carID, maintenanceDate, nextMaintenanceDate, status) => {
  if (status === "Cancelled") return; // a cancelled record doesn't need the car

  const maintConflict = await findBookingConflict(carID, maintenanceDate);
  if (maintConflict) {
    throw new Error(
      `Cannot save: this car has an active booking (${maintConflict.bookingID || maintConflict.id}) ` +
      `from ${fmtDate(toJSDate(maintConflict.startDateTime))} to ${fmtDate(toJSDate(maintConflict.endDateTime))} ` +
      `that overlaps the maintenance date.`
    );
  }

  if (nextMaintenanceDate) {
    const nextConflict = await findBookingConflict(carID, nextMaintenanceDate);
    if (nextConflict) {
      throw new Error(
        `Cannot save: this car has an active booking (${nextConflict.bookingID || nextConflict.id}) ` +
        `from ${fmtDate(toJSDate(nextConflict.startDateTime))} to ${fmtDate(toJSDate(nextConflict.endDateTime))} ` +
        `that overlaps the next maintenance date.`
      );
    }
  }
};

// ─────────────────────────────────────────────
// CONFIG — basis / status / service catalog, so the frontend never
// has to hardcode its own copy of these lists.
// ─────────────────────────────────────────────
export const getMaintenanceConfig = () => ({
  basisOptions: BASIS_OPTIONS,
  statusOptions: STATUS_OPTIONS,
  serviceCatalog: SERVICE_CATALOG,
});

// ─────────────────────────────────────────────
// GET all maintenance records (with car plate/brand/model denormalized in)
// ─────────────────────────────────────────────
export const getAllMaintenance = async () => {
  const [maintSnap, carsSnap, brandSnap, modelSnap] = await Promise.all([
    db.collection("carMaintenance").orderBy("createdAt", "desc").get(),
    db.collection("cars").get(),
    db.collection("brand").get(),
    db.collection("model").get(),
  ]);

  const carMap = Object.fromEntries(carsSnap.docs.map((d) => [d.id, d.data()]));
  const brandMap = Object.fromEntries(brandSnap.docs.map((d) => [d.id, d.data().brandName]));
  const modelMap = Object.fromEntries(modelSnap.docs.map((d) => [d.id, d.data().modelName]));

  return maintSnap.docs.map((d) => {
    const data = d.data();
    const car = carMap[data.carID];
    return {
      id: d.id,
      ...data,
      plateNumber: car?.plateNumber || "—",
      brandName: car ? brandMap[car.brandID] || "—" : "—",
      modelName: car ? modelMap[car.modelID] || "—" : "—",
      createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt ?? null,
      updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt ?? null,
    };
  });
};

// ─────────────────────────────────────────────
// GET single maintenance record by ID
// ─────────────────────────────────────────────
export const getMaintenanceById = async (maintenanceID) => {
  const doc = await db.collection("carMaintenance").doc(maintenanceID).get();
  if (!doc.exists) throw new Error("Maintenance record not found.");
  return { id: doc.id, ...doc.data() };
};

// ─────────────────────────────────────────────
// GET all maintenance records for a single car
// ─────────────────────────────────────────────
export const getMaintenanceByCar = async (carID) => {
  const snap = await db
    .collection("carMaintenance")
    .where("carID", "==", carID)
    .orderBy("createdAt", "desc")
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// ─────────────────────────────────────────────
// CREATE maintenance record
// ─────────────────────────────────────────────
export const createMaintenance = async (payload) => {
  const { carID, basis, services = [], overrideTotal, description = "", maintenanceDate = null, nextMaintenanceDate = null, status, partsAddressed = [] } = payload;

  if (!carID) throw new Error("carID is required.");
  if (!BASIS_OPTIONS.includes(basis)) throw new Error(`Invalid basis. Must be one of: ${BASIS_OPTIONS.join(", ")}`);

  const finalStatus = status || "Scheduled";
  if (!STATUS_OPTIONS.includes(finalStatus)) throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);

  const carDoc = await db.collection("cars").doc(carID).get();
  if (!carDoc.exists) throw new Error("Car not found.");

  await assertNoBookingConflict(carID, maintenanceDate, nextMaintenanceDate, finalStatus);

  const normalizedServices = normalizeServices(services);
  const totalCost = computeTotal(normalizedServices, overrideTotal);

  const ref = await db.collection("carMaintenance").add({
    carID,
    basis,
    services: normalizedServices,
    totalCost,
    overrideTotal: overrideTotal ? Number(overrideTotal) : null,
    description,
    maintenanceDate: toFirestoreDate(maintenanceDate),
    nextMaintenanceDate: toFirestoreDate(nextMaintenanceDate),
    status: finalStatus,
    // Which damaged/stolen/missing parts (from inventoryBeforeTrip/
    // inventoryAfterTrip's damageParts) this job is meant to fix. Not
    // resolved yet at creation — only actually applied to those trip
    // records once this maintenance record's status becomes "Completed"
    // (see updateMaintenanceStatus). Checking a box here just records
    // intent; a job that gets Cancelled instead should never mark a part
    // fixed that was never actually worked on.
    partsAddressed,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });

  // Mirror the doc's own ID onto itself, matching this app's existing convention
  await ref.update({ maintenanceID: ref.id });

  // Edge case: a record created already Completed (backdating a repair
  // that already happened) — resolve immediately rather than requiring a
  // separate edit afterward to trigger it.
  if (finalStatus === "Completed") {
    await resolveAddressedParts(ref.id, carID, partsAddressed);
  }

  return { id: ref.id };
};

// ─────────────────────────────────────────────
// UPDATE maintenance record
// ─────────────────────────────────────────────
// Resolves whichever damaged/stolen/missing parts a maintenance record's
// partsAddressed checklist named, by flipping each one's status to "Good"
// on its actual trip record (same write Maintenance.jsx's own "Mark
// Replaced" button uses). Called from both updateMaintenance (the real
// path the edit form's status picker actually uses) and
// updateMaintenanceStatus (the dedicated PATCH endpoint, kept in sync in
// case anything else calls it directly) — only ever on a genuine
// transition into "Completed", never on every re-save of an already-
// completed record, and never for Cancelled.
const resolveAddressedParts = async (maintenanceID, carID, partsAddressed) => {
  if (!Array.isArray(partsAddressed) || partsAddressed.length === 0) return;
  for (const p of partsAddressed) {
    try {
      await adminUpdateHistoryPartStatus({
        tripPhase: p.tripPhase,
        bookingID: p.bookingID,
        carID,
        carPartID: p.carPartID,
        newStatus: "Good",
        editedBy: null, // resolved via maintenance completion, not a direct admin edit
      });
    } catch (err) {
      // One part failing (e.g. its trip record was since deleted) shouldn't
      // block the others or the status update that already succeeded.
      console.error(`[MAINTENANCE] Failed to resolve part ${p.carPartID} on completion of ${maintenanceID}:`, err.message);
    }
  }
};

export const updateMaintenance = async (maintenanceID, payload) => {
  const ref = db.collection("carMaintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");

  const { carID, basis, services, overrideTotal, description, maintenanceDate, nextMaintenanceDate, status, partsAddressed } = payload;
  const existing = doc.data();

  const effectiveCarID   = carID !== undefined ? carID : existing.carID;
  const effectiveMaintDate = maintenanceDate !== undefined ? maintenanceDate : existing.maintenanceDate;
  const effectiveNextDate  = nextMaintenanceDate !== undefined ? nextMaintenanceDate : existing.nextMaintenanceDate;
  const effectiveStatus    = status !== undefined ? status : existing.status;

  await assertNoBookingConflict(effectiveCarID, effectiveMaintDate, effectiveNextDate, effectiveStatus);

  const update = { updatedAt: timestamp() };

  if (carID !== undefined) update.carID = carID;

  if (basis !== undefined) {
    if (!BASIS_OPTIONS.includes(basis)) throw new Error(`Invalid basis. Must be one of: ${BASIS_OPTIONS.join(", ")}`);
    update.basis = basis;
  }

  if (status !== undefined) {
    if (!STATUS_OPTIONS.includes(status)) throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);
    update.status = status;
  }

  if (description !== undefined) update.description = description;
  if (maintenanceDate !== undefined) update.maintenanceDate = toFirestoreDate(maintenanceDate);
  if (nextMaintenanceDate !== undefined) update.nextMaintenanceDate = toFirestoreDate(nextMaintenanceDate);
  if (partsAddressed !== undefined) update.partsAddressed = partsAddressed;

  // Recompute total whenever services or overrideTotal change
  if (services !== undefined || overrideTotal !== undefined) {
    const normalizedServices = normalizeServices(services !== undefined ? services : existing.services);
    const effectiveOverride = overrideTotal !== undefined ? overrideTotal : existing.overrideTotal;

    update.services = normalizedServices;
    update.overrideTotal = effectiveOverride ? Number(effectiveOverride) : null;
    update.totalCost = computeTotal(normalizedServices, effectiveOverride);
  }

  await ref.update(update);

  // Fires only on a genuine transition into Completed (existing status
  // wasn't already Completed) — this is the endpoint the real edit form's
  // status picker actually calls, so this is where completion needs to be
  // caught, not just the unused dedicated PATCH endpoint below.
  if (update.status === "Completed" && existing.status !== "Completed") {
    const effectiveParts = partsAddressed !== undefined ? partsAddressed : existing.partsAddressed;
    await resolveAddressedParts(maintenanceID, effectiveCarID, effectiveParts);
  }

  return { id: maintenanceID };
};

// ─────────────────────────────────────────────
// UPDATE status only
// ─────────────────────────────────────────────
export const updateMaintenanceStatus = async (maintenanceID, status) => {
  if (!STATUS_OPTIONS.includes(status)) throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);

  const ref = db.collection("carMaintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");
  const record = doc.data();

  await ref.update({ status, updatedAt: timestamp() });

  if (status === "Completed" && record.status !== "Completed") {
    await resolveAddressedParts(maintenanceID, record.carID, record.partsAddressed);
  }

  return { id: maintenanceID, status };
};

// ─────────────────────────────────────────────
// DELETE maintenance record
// ─────────────────────────────────────────────
export const deleteMaintenance = async (maintenanceID) => {
  const ref = db.collection("carMaintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");

  await ref.delete();
  return { id: maintenanceID };
};