import { db } from "../../config/firebaseConnection/firebase.js";

// ─────────────────────────────────────────────
// carParts.status = the part's LIVE condition
// ─────────────────────────────────────────────
// "Good" | "Damaged" | "Stolen" | "Missing".
//
// Nothing here is ever typed in by hand and nothing is edited incrementally.
// After anything that could change the answer, the car's part conditions are
// RECOMPUTED from the real sources and written back, so the stored status can't
// drift from them:
//
//   Two sources, the more recent event wins:
//     - the car's latest inspection: a part it lists as Damaged / Stolen / Missing is flagged
//     - Completed maintenance jobs on that car that cover the part and are not older than that
//       inspection (same booking as the inspection, or dated on or after its day — or any
//       Completed job when the car has no inspection at all). If several do, the MOST RECENT one
//       decides: its "After" condition "Good" fixes the part; "Damaged" leaves it flagged — or
//       flags it, when the job itself found the part damaged and no inspection had.
//   A part the inspection flagged as Stolen / Missing keeps that status while a job leaves it
//   Damaged; a part only the job found is "Damaged". Every other part is "Good".
//
// "Latest inspection" per car = its newest after-trip record, else its newest
// before-trip record. This is the same rule as the frontend's
// src/utils/damagedParts.js — keep the two in step. Days are compared in
// Philippine time (UTC+8): an inspection is stamped with the real moment while a
// job's date is just a day.
//
// The inspection records themselves are history and are never edited by this.
//
// Where the recompute is triggered (syncCarPartConditions):
//   inspections saved / edited by an admin  -> inventory.service.js, vehicleDocumentation.service.js
//   maintenance created / edited / completed / deleted -> maintenance.service.js
//   a booking's inspections + jobs deleted or restored  -> bookingDelete.service.js, the two archive services
// A car's parts are brought up to date the next time any of those things happens to that car.

const PH_OFFSET_MS = 8 * 60 * 60 * 1000;
const phDay = (ms) => Math.floor((ms + PH_OFFSET_MS) / 86400000);
const DAMAGED_STATUSES = ["Damaged", "Stolen", "Missing"];

const toJSDate = (val) => {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  const d = new Date(val);
  return isNaN(d) ? null : d;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// Parts of one car that are currently NOT fine: [{ carPartID, status }].
export const getUnresolvedDamage = async (carID) => {
  const [afterSnap, beforeSnap, jobsSnap] = await Promise.all([
    db.collection("inventoryAfterTrip").where("carID", "==", carID).get(),
    db.collection("inventoryBeforeTrip").where("carID", "==", carID).get(),
    db.collection("maintenance").where("carID", "==", carID).where("status", "==", "Completed").get(),
  ]);

  const latest = (snap) => {
    let best = null;
    for (const d of snap.docs) {
      const data = d.data();
      const ms = toJSDate(data.recordedAt)?.getTime() ?? 0;
      if (!best || ms > best.ms) best = { data, ms };
    }
    return best;
  };
  const rec = latest(afterSnap) || latest(beforeSnap); // null when the car has no inspection yet
  const jobs = jobsSnap.docs.map((d) => d.data());

  const flaggedByInspection = new Map(
    (rec?.data.damageParts || []).filter((p) => DAMAGED_STATUSES.includes(p.status)).map((p) => [p.carPartID, p.status])
  );

  // The most recent Completed job that covers this part and is not older than the latest inspection.
  const latestJobEntry = (carPartID) => {
    let latest = null;
    for (const job of jobs) {
      const entry = (job.partsAddressed || []).find((e) => e?.carPartID === carPartID);
      if (!entry) continue;
      const jobMs = toJSDate(job.maintenanceDate)?.getTime() ?? 0;
      const sameBooking = rec && job.bookingID && rec.data.bookingID && job.bookingID === rec.data.bookingID;
      if (rec && !sameBooking && !(jobMs > 0 && phDay(jobMs) >= phDay(rec.ms))) continue;
      const updatedMs = toJSDate(job.updatedAt)?.getTime() ?? 0;
      if (!latest || jobMs > latest.jobMs || (jobMs === latest.jobMs && updatedMs >= latest.updatedMs)) {
        latest = { entry, jobMs, updatedMs };
      }
    }
    return latest;
  };

  const partIDs = new Set(flaggedByInspection.keys());
  for (const job of jobs) for (const e of job.partsAddressed || []) if (e?.carPartID) partIDs.add(e.carPartID);

  const out = [];
  for (const carPartID of partIDs) {
    const inspectionStatus = flaggedByInspection.get(carPartID) || null;
    const job = latestJobEntry(carPartID);
    let status;
    if (job) status = job.entry.conditionAfter === "Damaged" ? inspectionStatus || "Damaged" : null;
    else status = inspectionStatus;
    if (status) out.push({ carPartID, status });
  }
  return out;
};

// Recompute one car's parts and write `status` on the ones that differ (only those — no
// pointless writes). Returns what changed.
export const recomputeCarPartConditions = async (carID) => {
  if (!carID) return { carID, checked: 0, changed: [] };

  const [damage, partsSnap] = await Promise.all([
    getUnresolvedDamage(carID),
    db.collection("carParts").where("carID", "==", carID).get(),
  ]);
  const flagged = new Map(damage.map((d) => [d.carPartID, d.status]));

  const changes = [];
  for (const doc of partsSnap.docs) {
    const want = flagged.get(doc.id) || "Good";
    const have = doc.data().status ?? null;
    if (have !== want) changes.push({ ref: doc.ref, id: doc.id, from: have, to: want });
  }

  for (const part of chunk(changes, 400)) {
    const batch = db.batch();
    part.forEach((c) => batch.update(c.ref, { status: c.to }));
    await batch.commit();
  }
  return { carID, checked: partsSnap.size, changed: changes.map(({ id, from, to }) => ({ id, from, to })) };
};

// What the write paths call, AFTER their own write has succeeded. Never throws: the inspection /
// job / delete the person asked for already happened, so a failed sync is logged (and repaired by
// the next time something saves for that car) instead of reporting the whole save as failed.
// Accepts any mix of carIDs and arrays of them; blanks and duplicates are ignored.
export const syncCarPartConditions = async (...carIDs) => {
  const unique = [...new Set(carIDs.flat().filter(Boolean))];
  for (const carID of unique) {
    try {
      await recomputeCarPartConditions(carID);
    } catch (err) {
      console.error(`[CAR_PART_CONDITIONS] Sync failed for car ${carID} — it will be corrected the next time an inspection or maintenance job is saved for this car:`, err);
    }
  }
};