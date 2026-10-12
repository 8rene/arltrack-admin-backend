import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import {
  BASIS_OPTIONS, STATUS_OPTIONS, SERVICE_CATALOG,
  PART_CONDITION_BEFORE, PART_CONDITION_AFTER,
} from "../../models/maintenance/maintenance.model.js";
import { createAuditLog } from "../auditLogs/auditLogs.service.js";
import { notifyOwners } from "../notification/notification.service.js";
import { ROLES } from "../../utils/roles/role.util.js";

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

// An override of exactly 0 is a real override (a free job), so "is there one"
// is decided by blank-ness, never by truthiness.
const hasOverride = (v) => v !== undefined && v !== null && v !== "";

// Server-side total: services + parts, unless overrideTotal is provided.
const computeTotal = (services, overrideTotal, parts = []) => {
  if (hasOverride(overrideTotal)) {
    const total = Number(overrideTotal);
    if (!Number.isFinite(total) || total < 0) throw new Error("overrideTotal must be a number that is 0 or greater.");
    return Math.round(total * 100) / 100;
  }
  const sum = services.reduce((acc, s) => acc + s.price, 0)
            + parts.reduce((acc, p) => acc + (Number(p.price) || 0), 0);
  return Math.round(sum * 100) / 100;
};

// ─────────────────────────────────────────────
// partsAddressed — validate + normalize (see PartAddressed in maintenance.model.js)
// ─────────────────────────────────────────────

const toMoney = (val, label) => {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number that is 0 or greater.`);
  return Math.round(n * 100) / 100;
};

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// carPartID -> condition, from the car's LATEST inspection: the after-trip
// record if there is one, otherwise the before-trip record (the same rule the
// Maintenance page already uses for its "Damaged Parts Require Attention"
// panel). Parts the inspection doesn't list are Good. Read-only — maintenance
// never writes to inspection records; they are history.
const getLatestInspectionConditions = async (carID) => {
  const latestFor = async (collectionName) => {
    const snap = await db.collection(collectionName).where("carID", "==", carID).get();
    let best = null;
    let bestMs = -1;
    for (const d of snap.docs) {
      const ms = toJSDate(d.data().recordedAt)?.getTime() ?? 0;
      if (ms > bestMs) { best = d.data(); bestMs = ms; }
    }
    return best;
  };
  const record = (await latestFor("inventoryAfterTrip")) || (await latestFor("inventoryBeforeTrip"));

  const conditions = new Map();
  for (const p of record?.damageParts || []) {
    if (PART_CONDITION_BEFORE.includes(p.status)) conditions.set(p.carPartID, p.status);
  }
  return conditions;
};

// Validates the partsAddressed[] from a request body and returns the entries
// as they should be stored: exactly { carPartID, conditionBefore, conditionAfter,
// description, price } — any other keys (the old carID / carPartName /
// tripPhase / bookingID) are dropped.
//
//  - every entry needs a carPartID, no duplicates
//  - the part must exist and belong to the job's car
//  - conditionBefore / conditionAfter / description / price: validated when sent.
//    When NOT sent, a part that is already on this job keeps its stored value
//    (so a re-save never wipes the snapshot), and a newly added part gets
//    conditionBefore from the car's latest inspection, conditionAfter null,
//    description "" and price 0.
//  - a part already on the job whose carParts doc has since been removed is
//    kept as-is rather than blocking every future edit of the job
const normalizePartsAddressed = async (incoming, carID, existingEntries = []) => {
  if (!Array.isArray(incoming)) throw new Error("partsAddressed must be an array.");

  const existingByID = new Map(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .filter((e) => e && e.carPartID)
      .map((e) => [e.carPartID, e])
  );

  const seen = new Set();
  const entries = incoming.map((e) => {
    if (!e || typeof e !== "object" || typeof e.carPartID !== "string" || !e.carPartID.trim()) {
      throw new Error("Each part needs a carPartID.");
    }
    const carPartID = e.carPartID.trim();
    if (seen.has(carPartID)) throw new Error(`Part ${carPartID} is listed more than once.`);
    seen.add(carPartID);
    return { ...e, carPartID };
  });

  const partSnaps = await Promise.all(entries.map((e) => db.collection("carParts").doc(e.carPartID).get()));

  let inspectionConditions = null; // loaded lazily — only if a new part needs conditionBefore
  const out = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const snap = partSnaps[i];
    const prev = existingByID.get(e.carPartID);

    if (snap.exists) {
      if (snap.data().carID !== carID) {
        throw new Error(`Part "${snap.data().carPartName || e.carPartID}" does not belong to this car.`);
      }
    } else if (!prev) {
      throw new Error(`Part ${e.carPartID} not found.`);
    }

    // conditionBefore
    let conditionBefore;
    if (!isBlank(e.conditionBefore)) {
      if (!PART_CONDITION_BEFORE.includes(e.conditionBefore)) {
        throw new Error(`Invalid conditionBefore. Must be one of: ${PART_CONDITION_BEFORE.join(", ")}`);
      }
      conditionBefore = e.conditionBefore;
    } else if (PART_CONDITION_BEFORE.includes(prev?.conditionBefore)) {
      conditionBefore = prev.conditionBefore;
    } else {
      if (!inspectionConditions) inspectionConditions = await getLatestInspectionConditions(carID);
      conditionBefore = inspectionConditions.get(e.carPartID) || "Good";
    }

    // conditionAfter (null until the job has actually done something to the part)
    let conditionAfter;
    if (e.conditionAfter === undefined) {
      conditionAfter = PART_CONDITION_AFTER.includes(prev?.conditionAfter) ? prev.conditionAfter : null;
    } else if (isBlank(e.conditionAfter)) {
      conditionAfter = null;
    } else if (PART_CONDITION_AFTER.includes(e.conditionAfter)) {
      conditionAfter = e.conditionAfter;
    } else {
      throw new Error(`Invalid conditionAfter. Must be one of: ${PART_CONDITION_AFTER.join(", ")}`);
    }

    // description
    let description;
    if (e.description === undefined || e.description === null) {
      description = typeof prev?.description === "string" ? prev.description : "";
    } else if (typeof e.description === "string") {
      description = e.description.trim();
    } else {
      throw new Error("Part description must be text.");
    }

    // price
    const price = isBlank(e.price)
      ? (Number.isFinite(Number(prev?.price)) ? Number(prev.price) : 0)
      : toMoney(e.price, "Part price");

    out.push({ carPartID: e.carPartID, conditionBefore, conditionAfter, description, price });
  }

  return out;
};

// ─────────────────────────────────────────────
// Completing a job — what it does to its parts
// ─────────────────────────────────────────────
// Completing a job stamps each part's conditionAfter (Good / Damaged) and
// updates the carParts doc so the part's CURRENT condition is right. It never
// touches the before/after-trip inspection records — those stay as filed.
//
//   Good    -> carParts.status "Good"
//   Damaged -> carParts.status "Damaged" (work done but not fixed)
//
// Reopening a completed job (or deleting it) undoes the carParts change.
// Entries with no conditionAfter (jobs completed before this existed) are never
// touched in either direction.

// Used only when the person didn't choose: a completed job is assumed to have
// left the part Good. (How it was fixed goes in the part's description.)
const defaultConditionAfter = () => "Good";

const withConditionAfter = (part) =>
  part.conditionAfter ? part : { ...part, conditionAfter: defaultConditionAfter(part.conditionBefore) };

// Works out the final parts[] to store plus which carParts to move to
// "done" (complete) and which to put back (reopen), from the status change.
const planPartEffects = ({ wasCompleted, nowCompleted, existingParts = [], newParts = [] }) => {
  const existingByID = new Map(existingParts.filter((e) => e?.carPartID).map((e) => [e.carPartID, e]));
  const newIDs = new Set(newParts.map((p) => p.carPartID));
  const removed = existingParts.filter((e) => e?.carPartID && !newIDs.has(e.carPartID) && e.conditionAfter);

  if (!wasCompleted && nowCompleted) {
    const parts = newParts.map(withConditionAfter);
    return { parts, complete: parts, reopen: [] };
  }
  if (wasCompleted && nowCompleted) {
    // Only parts that are new to the job, or whose outcome was just changed,
    // need their carParts doc touched again.
    const parts = newParts.map((p) => (existingByID.has(p.carPartID) ? p : withConditionAfter(p)));
    const complete = parts.filter((p) => {
      const prev = existingByID.get(p.carPartID);
      return p.conditionAfter && (!prev || prev.conditionAfter !== p.conditionAfter);
    });
    return { parts, complete, reopen: removed };
  }
  if (wasCompleted && !nowCompleted) {
    return { parts: newParts, complete: [], reopen: existingParts.filter((e) => e?.carPartID && e.conditionAfter) };
  }
  return { parts: newParts, complete: [], reopen: [] };
};

// Queues the carParts writes for a plan onto a Firestore batch.
const queueCarPartWrites = async (batch, plan) => {
  const touch = async (parts, fn) => {
    for (const p of parts) {
      const ref = db.collection("carParts").doc(p.carPartID);
      const snap = await ref.get();
      if (snap.exists) fn(ref, p);
    }
  };
  await touch(plan.complete, (ref, p) => {
    if (p.conditionAfter === "Damaged") {
      batch.update(ref, { status: "Damaged" });
    } else {
      batch.update(ref, { status: "Good" });
    }
  });
  // Reopening puts the part back to how it was before the job.
  await touch(plan.reopen, (ref, p) => {
    batch.update(ref, { status: p.conditionBefore === "Damaged" ? "Damaged" : "Good" });
  });
};

const partsNote = (plan) => {
  const bits = [];
  if (plan.complete.length) bits.push(`${plan.complete.length} part(s) marked done`);
  if (plan.reopen.length) bits.push(`${plan.reopen.length} part(s) reopened`);
  return bits.length ? ` — ${bits.join(", ")}` : "";
};

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const fmtDate = (d) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });

// Looks up a car's plate number for audit-log descriptions, so entries read
// "Maintenance for ABC-1234" instead of a bare carID. Falls back to the raw
// carID if the car doc is somehow gone by the time this runs.
const getPlateNumber = async (carID) => {
  if (!carID) return "unknown car";
  const snap = await db.collection("cars").doc(carID).get();
  return snap.exists ? snap.data().plateNumber || carID : carID;
};

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

// Runs the conflict check against the maintenance date and throws a descriptive
// error naming the conflicting booking, so the save is blocked with a
// clear reason rather than silently failing.
const assertNoBookingConflict = async (carID, maintenanceDate, status) => {
  if (status === "Cancelled") return; // a cancelled record doesn't need the car

  const maintConflict = await findBookingConflict(carID, maintenanceDate);
  if (maintConflict) {
    throw new Error(
      `Cannot save: this car has an active booking (${maintConflict.bookingID || maintConflict.id}) ` +
      `from ${fmtDate(toJSDate(maintConflict.startDateTime))} to ${fmtDate(toJSDate(maintConflict.endDateTime))} ` +
      `that overlaps the maintenance date.`
    );
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
  partConditionBefore: PART_CONDITION_BEFORE,
  partConditionAfter: PART_CONDITION_AFTER,
});

// ─────────────────────────────────────────────
// GET all maintenance records (with car plate/brand/model denormalized in)
// ─────────────────────────────────────────────
export const getAllMaintenance = async () => {
  const [maintSnap, carsSnap, brandSnap, modelSnap] = await Promise.all([
    db.collection("maintenance").orderBy("createdAt", "desc").get(),
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
  const doc = await db.collection("maintenance").doc(maintenanceID).get();
  if (!doc.exists) throw new Error("Maintenance record not found.");
  return { id: doc.id, ...doc.data() };
};

// ─────────────────────────────────────────────
// GET all maintenance records for a single car
// ─────────────────────────────────────────────
export const getMaintenanceByCar = async (carID) => {
  const snap = await db
    .collection("maintenance")
    .where("carID", "==", carID)
    .orderBy("createdAt", "desc")
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// Every maintenance record tied to one booking — powers the "linked
// maintenance" list on a booking's detail view (Bookings.jsx). Most
// bookings will return an empty array here, since routine maintenance
// isn't tied to any particular rental.
//
// No orderBy in the query itself on purpose — where("bookingID", ...) +
// orderBy("createdAt") on a different field needs a Firestore composite
// index that doesn't exist for this collection. Sorted client-side below
// instead, same visible result (newest first) without needing an index
// created for this collection — same tradeoff already made for
// editRequests/idResubmitRequests in the admin frontend's Account.jsx.
export const listMaintenanceForBooking = async (bookingID) => {
  const snap = await db
    .collection("maintenance")
    .where("bookingID", "==", bookingID)
    .get();

  const toMillis = (ts) => ts?.toMillis?.() ?? ts?._seconds * 1000 ?? 0;

  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
};

// ─────────────────────────────────────────────
// CREATE maintenance record
// ─────────────────────────────────────────────
// actor: { role } of whoever is creating it (the controller passes req.user.role).
// A Supervisor creating a record notifies the Owner(s); nobody else triggers it.
export const createMaintenance = async (payload, editedBy = null, actor = {}) => {
  const { carID, bookingID = null, basis, services = [], overrideTotal, description = "", maintenanceDate = null, status, partsAddressed = [] } = payload;

  if (!carID) throw new Error("carID is required.");
  if (!BASIS_OPTIONS.includes(basis)) throw new Error(`Invalid basis. Must be one of: ${BASIS_OPTIONS.join(", ")}`);

  const finalStatus = status || "Scheduled";
  if (!STATUS_OPTIONS.includes(finalStatus)) throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);

  const carDoc = await db.collection("cars").doc(carID).get();
  if (!carDoc.exists) throw new Error("Car not found.");

  await assertNoBookingConflict(carID, maintenanceDate, finalStatus);

  const normalizedServices = normalizeServices(services);
  const checkedParts = await normalizePartsAddressed(partsAddressed, carID);
  const plan = planPartEffects({ wasCompleted: false, nowCompleted: finalStatus === "Completed", newParts: checkedParts });
  const normalizedParts = plan.parts;
  const totalCost = computeTotal(normalizedServices, overrideTotal, normalizedParts);

  const ref = db.collection("maintenance").doc();
  const batch = db.batch();
  batch.set(ref, {
    maintenanceID: ref.id,   // mirror the doc's own ID onto itself, matching this app's convention
    carID,
    // FK -> bookings. Null for routine/scheduled maintenance that isn't
    // tied to any one rental (oil changes, monthly checks). Set manually
    // via the "+ Post-Rental Maintenance" button on a booking's detail
    // view (Bookings.jsx's goToMaintenance), which deep-links here with
    // ?carID=&bookingID= pre-filled. See
    // listMaintenanceForBooking() below for the read side — this is what
    // lets a booking's detail view show "linked maintenance" and what a
    // penalty's optional maintenanceID field can point back to.
    bookingID,
    basis,
    services: normalizedServices,
    totalCost,
    overrideTotal: hasOverride(overrideTotal) ? totalCost : null,
    description,
    maintenanceDate: toFirestoreDate(maintenanceDate),
    status: finalStatus,
    // The car parts this job handles — validated, and stored in the slim
    // { carPartID, conditionBefore, conditionAfter, description, price }
    // shape (see PartAddressed in maintenance.model.js). The before/after-trip
    // inspection records are never touched by maintenance: they stay as filed.
    partsAddressed: normalizedParts,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  await queueCarPartWrites(batch, plan);
  await batch.commit();

  await createAuditLog({
    action: "create",
    description: `Maintenance scheduled for ${carDoc.data().plateNumber || carID} (${basis}, ${finalStatus}): ` +
      `${description || "no description"} — total ₱${totalCost.toFixed(2)}${partsNote(plan)}.`,
    userID: editedBy,
  });

  // A Supervisor scheduled this — let the Owner(s) know. Never blocks or fails the create.
  if (actor?.role === ROLES.SUPERVISOR) {
    try {
      let by = "A Supervisor";
      if (editedBy) {
        const [detail, user] = await Promise.all([
          db.collection("userDetails").doc(editedBy).get(),
          db.collection("user").doc(editedBy).get(),
        ]);
        const d = detail.exists ? detail.data() : {};
        const u = user.exists ? user.data() : {};
        const name = [d.firstName, d.lastName].filter(Boolean).join(" ").trim() || u.username || u.email;
        if (name) by = `${name} (Supervisor)`;
      }
      const plate = carDoc.data().plateNumber || carID;
      await notifyOwners({
        type: "maintenance_created",
        refID: ref.id,
        refCollection: "maintenance",
        title: "Maintenance Created",
        message: `${by} scheduled ${basis} maintenance for ${plate} (${finalStatus}) — ₱${totalCost.toFixed(2)}.`,
        extra: { carID },
      });
    } catch (err) {
      console.error("[MAINTENANCE] Owner notification failed:", err.message);
    }
  }

  return { id: ref.id };
};

// ─────────────────────────────────────────────
// UPDATE maintenance record
// ─────────────────────────────────────────────
export const updateMaintenance = async (maintenanceID, payload, editedBy = null) => {
  const ref = db.collection("maintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");

  const { carID, basis, services, overrideTotal, description, maintenanceDate, status, partsAddressed } = payload;
  const existing = doc.data();

  const effectiveCarID   = carID !== undefined ? carID : existing.carID;
  const effectiveMaintDate = maintenanceDate !== undefined ? maintenanceDate : existing.maintenanceDate;
  const effectiveStatus    = status !== undefined ? status : existing.status;

  await assertNoBookingConflict(effectiveCarID, effectiveMaintDate, effectiveStatus);

  // Validate parts BEFORE any write, so a bad part never leaves the record half-updated.
  // Re-checked when the parts list is sent, and also when the car is changed (the
  // job's existing parts must belong to the new car too).
  const carChanged = carID !== undefined && carID !== existing.carID;
  let checkedParts;
  if (partsAddressed !== undefined || carChanged) {
    checkedParts = await normalizePartsAddressed(
      partsAddressed !== undefined ? partsAddressed : existing.partsAddressed || [],
      effectiveCarID,
      existing.partsAddressed
    );
  }

  // Status change -> what happens to the parts (see planPartEffects).
  const plan = planPartEffects({
    wasCompleted: existing.status === "Completed",
    nowCompleted: effectiveStatus === "Completed",
    existingParts: existing.partsAddressed || [],
    newParts: checkedParts !== undefined ? checkedParts : existing.partsAddressed || [],
  });
  const partsChanged = checkedParts !== undefined || plan.parts.some((p, i) => p !== (existing.partsAddressed || [])[i]);

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
  if (checkedParts !== undefined || plan.complete.length || plan.reopen.length) update.partsAddressed = plan.parts;

  // Recompute total whenever services, parts or overrideTotal change
  if (services !== undefined || overrideTotal !== undefined || partsChanged) {
    const normalizedServices = normalizeServices(services !== undefined ? services : existing.services || []);
    const effectiveOverride = overrideTotal !== undefined ? overrideTotal : existing.overrideTotal;

    update.services = normalizedServices;
    update.totalCost = computeTotal(normalizedServices, effectiveOverride, plan.parts);
    update.overrideTotal = hasOverride(effectiveOverride) ? update.totalCost : null;
  }

  // One batch: the job and its carParts change together or not at all.
  const batch = db.batch();
  batch.update(ref, update);
  await queueCarPartWrites(batch, plan);
  await batch.commit();

  const plate = await getPlateNumber(effectiveCarID);
  const statusNote = status !== undefined && status !== existing.status
    ? ` — status changed from ${existing.status} to ${status}`
    : "";
  // maintenance.totalCost is the only copy of the cost (no Expense log mirrors it any more), so a revision is
  // kept as history here instead.
  const costNote = update.totalCost !== undefined && update.totalCost !== existing.totalCost
    ? ` — cost revised from ₱${(existing.totalCost || 0).toFixed(2)} to ₱${update.totalCost.toFixed(2)}`
    : "";
  await createAuditLog({
    action: "update",
    description: `Maintenance record for ${plate} updated${statusNote}${costNote}${partsNote(plan)}.`,
    userID: editedBy,
  });

  return { id: maintenanceID };
};

// ─────────────────────────────────────────────
// UPDATE status only
// ─────────────────────────────────────────────
export const updateMaintenanceStatus = async (maintenanceID, status, editedBy = null) => {
  if (!STATUS_OPTIONS.includes(status)) throw new Error(`Invalid status. Must be one of: ${STATUS_OPTIONS.join(", ")}`);

  const ref = db.collection("maintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");
  const record = doc.data();

  const plan = planPartEffects({
    wasCompleted: record.status === "Completed",
    nowCompleted: status === "Completed",
    existingParts: record.partsAddressed || [],
    newParts: record.partsAddressed || [],
  });

  const batch = db.batch();
  const update = { status, updatedAt: timestamp() };
  if (plan.complete.length || plan.reopen.length) update.partsAddressed = plan.parts;
  batch.update(ref, update);
  await queueCarPartWrites(batch, plan);
  await batch.commit();

  const plate = await getPlateNumber(record.carID);
  await createAuditLog({
    action: "update",
    description: `Maintenance status for ${plate} changed from ${record.status} to ${status}${partsNote(plan)}.`,
    userID: editedBy,
  });

  return { id: maintenanceID, status };
};

// ─────────────────────────────────────────────
// DELETE maintenance record
// ─────────────────────────────────────────────
export const deleteMaintenance = async (maintenanceID, editedBy = null) => {
  const ref = db.collection("maintenance").doc(maintenanceID);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Maintenance record not found.");
  const record = doc.data();

  // Deleting a completed job puts its parts back (the part is no longer "fixed by" anything).
  const plan = record.status === "Completed"
    ? planPartEffects({ wasCompleted: true, nowCompleted: false, existingParts: record.partsAddressed || [], newParts: [] })
    : { parts: [], complete: [], reopen: [] };
  const batch = db.batch();
  batch.delete(ref);
  await queueCarPartWrites(batch, plan);
  await batch.commit();

  const plate = await getPlateNumber(record.carID);
  await createAuditLog({
    action: "delete",
    description: `Maintenance record for ${plate} deleted (was ${record.status}, ${record.basis}, ` +
      `${record.description || "no description"}).`,
    userID: editedBy,
  });

  return { id: maintenanceID };
};