import { db } from "../../config/firebaseConnection/firebase.js";

// The 4-level PH address hierarchy: regions -> provinces -> municipalities
// -> barangays. One config table drives every level so list/add/edit/delete
// share a single code path.
//
// IDs: each doc gets Firestore's own random auto-ID, and that same ID is
// also written into the doc's own …ID field — matching every existing
// regions/provinces/municipalities/barangays document.
export const LEVELS = {
  regions: {
    collection: "regions",
    idField: "regionID",
    nameField: "regionName",
    noun: "Region",
    parent: null,
  },
  provinces: {
    collection: "provinces",
    idField: "provinceID",
    nameField: "provinceName",
    noun: "Province",
    parent: { level: "regions", field: "regionID", noun: "Region" },
  },
  municipalities: {
    collection: "municipalities",
    idField: "municipalityID",
    nameField: "municipalityName",
    noun: "Municipality",
    parent: { level: "provinces", field: "provinceID", noun: "Province" },
  },
  barangays: {
    collection: "barangays",
    idField: "barangayID",
    nameField: "barangayName",
    noun: "Barangay",
    parent: { level: "municipalities", field: "municipalityID", noun: "Municipality" },
  },
};

const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const getLevel = (levelKey) => {
  const level = LEVELS[levelKey];
  if (!level) throw httpError(400, `Unknown address level "${levelKey}".`);
  return level;
};

// Falls back to the doc ID so a row still shows even if its own …ID field is blank.
const shape = (level, doc) => {
  const d = doc.data();
  const out = {
    [level.idField]: d[level.idField] || doc.id,
    [level.nameField]: d[level.nameField] || "",
  };
  if (level.parent) out[level.parent.field] = d[level.parent.field] || "";
  return out;
};

const cmp = (a, b) => (a || "").localeCompare(b || "");

/**
 * Loads all four collections in parallel. Regions and provinces sort A-Z;
 * municipalities and barangays sort hierarchically — grouped under their
 * parent (province / municipality) A-Z first, then A-Z by their own name —
 * so browsing lines up with the real address hierarchy.
 */
export const listAddresses = async () => {
  const [r, p, m, b] = await Promise.all(
    ["regions", "provinces", "municipalities", "barangays"].map(async (key) => {
      const level = LEVELS[key];
      const snap = await db.collection(level.collection).get();
      return snap.docs.map((doc) => shape(level, doc));
    })
  );

  const regionName = Object.fromEntries(r.map((x) => [x.regionID, x.regionName]));
  const provinceName = Object.fromEntries(p.map((x) => [x.provinceID, x.provinceName]));
  const municipalityName = Object.fromEntries(m.map((x) => [x.municipalityID, x.municipalityName]));

  return {
    regions: r.sort((a, c) => cmp(a.regionName, c.regionName)),
    provinces: p.sort((a, c) =>
      cmp(regionName[a.regionID], regionName[c.regionID]) || cmp(a.provinceName, c.provinceName)),
    municipalities: m.sort((a, c) =>
      cmp(provinceName[a.provinceID], provinceName[c.provinceID]) || cmp(a.municipalityName, c.municipalityName)),
    barangays: b.sort((a, c) =>
      cmp(municipalityName[a.municipalityID], municipalityName[c.municipalityID]) || cmp(a.barangayName, c.barangayName)),
  };
};

/**
 * Shared validation for add + edit: name required, parent (if the level has
 * one) required AND must actually exist — so the hierarchy the rest of the
 * app relies on never gets a dangling link — and no sibling under the same
 * parent may already have that name.
 */
const validateEntry = async (level, { name, parentID }, selfID = null, existing = null) => {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw httpError(400, `${level.noun} name is required.`);

  let cleanParent = null;
  if (level.parent) {
    cleanParent = String(parentID ?? "").trim();
    if (!cleanParent) throw httpError(400, `${level.parent.noun} is required.`);
    const parentSnap = await db.collection(LEVELS[level.parent.level].collection).doc(cleanParent).get();
    if (!parentSnap.exists) throw httpError(400, `The selected ${level.parent.noun.toLowerCase()} no longer exists.`);
  }

  // Saving an entry with its name AND parent unchanged is never a "new"
  // duplicate — this keeps legacy docs that already have a same-named sibling
  // editable/saveable instead of locking them out.
  const unchanged =
    existing &&
    String(existing[level.nameField] || "").trim().toLowerCase() === cleanName.toLowerCase() &&
    (!level.parent || (existing[level.parent.field] || "") === cleanParent);
  if (unchanged) return { cleanName, cleanParent };

  const siblingsQuery = level.parent
    ? db.collection(level.collection).where(level.parent.field, "==", cleanParent)
    : db.collection(level.collection);
  const siblings = await siblingsQuery.get();
  const clash = siblings.docs.find(
    (doc) => doc.id !== selfID && String(doc.data()[level.nameField] || "").trim().toLowerCase() === cleanName.toLowerCase()
  );
  if (clash) {
    throw httpError(
      409,
      level.parent
        ? `"${cleanName}" already exists under that ${level.parent.noun.toLowerCase()}.`
        : `"${cleanName}" already exists.`
    );
  }

  return { cleanName, cleanParent };
};

export const createEntry = async (levelKey, input) => {
  const level = getLevel(levelKey);
  const { cleanName, cleanParent } = await validateEntry(level, input);
  const ref = db.collection(level.collection).doc();
  await ref.set({
    [level.idField]: ref.id,
    [level.nameField]: cleanName,
    ...(level.parent ? { [level.parent.field]: cleanParent } : {}),
  });
  return shape(level, await ref.get());
};

export const updateEntry = async (levelKey, id, input) => {
  const level = getLevel(levelKey);
  const ref = db.collection(level.collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, `${level.noun} not found.`);
  const { cleanName, cleanParent } = await validateEntry(level, input, id, snap.data());
  await ref.update({
    [level.nameField]: cleanName,
    ...(level.parent ? { [level.parent.field]: cleanParent } : {}),
  });
  return shape(level, await ref.get());
};

/**
 * Deletes ONE entry. Like the original Addresses tab, this does not cascade —
 * a region's provinces, a province's municipalities, etc. are left in place
 * (the UI says so in its confirm dialog).
 */
export const deleteEntry = async (levelKey, id) => {
  const level = getLevel(levelKey);
  const ref = db.collection(level.collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, `${level.noun} not found.`);
  const removed = shape(level, snap);
  await ref.delete();
  return removed;
};

// ─────────────────────────────────────────────
// Batch save — powers the single-modal Address editor
// ─────────────────────────────────────────────
// One request carries every change made in the editor, so a whole branch
// (e.g. a new region with its provinces, municipalities and barangays, or a
// rename of several municipalities at once) is saved together.
//
// ops: [
//   { op: "create", level, tempID, name, parentID }   // parentID may be another op's tempID
//   { op: "update", level, id, name, parentID? }       // parentID only when moving it
//   { op: "delete", level, id }                        // also removes everything underneath it
// ]
//
// The ops are applied to an in-memory copy of the four collections first, the
// result is validated (names, parents, duplicate siblings), and only then
// written — in Firestore batches of BATCH_SIZE (creates first, deletes last).
const CHILD_LEVEL = { regions: "provinces", provinces: "municipalities", municipalities: "barangays", barangays: null };
const MAX_OPS = 5000;
const BATCH_SIZE = 400;
const cleanStr = (v) => String(v ?? "").trim();

export const applyChanges = async (ops, { canDelete = false } = {}) => {
  if (!Array.isArray(ops) || ops.length === 0) throw httpError(400, "There are no changes to save.");
  if (ops.length > MAX_OPS) throw httpError(400, `Too many changes at once (limit ${MAX_OPS}).`);

  const keys = Object.keys(LEVELS);

  // Current state: levelKey -> Map(docID -> { name, parentID })
  const state = {};
  await Promise.all(keys.map(async (key) => {
    const level = LEVELS[key];
    const snap = await db.collection(level.collection).get();
    state[key] = new Map(snap.docs.map((doc) => {
      const s = shape(level, doc);
      return [doc.id, { name: s[level.nameField], parentID: level.parent ? s[level.parent.field] : null }];
    }));
  }));
  const initial = {};
  keys.forEach((k) => { initial[k] = new Map([...state[k]].map(([id, v]) => [id, { ...v }])); });

  const tempMap = new Map(); // tempID -> real doc ID (for creates in this batch)
  const resolve = (id) => tempMap.get(cleanStr(id)) || cleanStr(id);

  // an entry plus everything underneath it
  const subtreeOf = (levelKey, id) => {
    const out = [{ levelKey, id }];
    const childKey = CHILD_LEVEL[levelKey];
    if (childKey) for (const [cid, c] of state[childKey]) if (c.parentID === id) out.push(...subtreeOf(childKey, cid));
    return out;
  };

  const requireParent = (level, parentID) => {
    if (!state[level.parent.level].has(parentID)) {
      throw httpError(400, `The selected ${level.parent.noun.toLowerCase()} no longer exists.`);
    }
  };

  for (const op of ops) {
    const levelKey = op?.level;
    const level = getLevel(levelKey);

    if (op.op === "create") {
      const name = cleanStr(op.name);
      if (!name) throw httpError(400, `${level.noun} name is required.`);
      let parentID = null;
      if (level.parent) {
        parentID = resolve(op.parentID);
        if (!parentID) throw httpError(400, `${level.parent.noun} is required.`);
        requireParent(level, parentID);
      }
      const id = db.collection(level.collection).doc().id;
      if (op.tempID) tempMap.set(cleanStr(op.tempID), id);
      state[levelKey].set(id, { name, parentID });

    } else if (op.op === "update") {
      const id = resolve(op.id);
      const entry = state[levelKey].get(id);
      if (!entry) throw httpError(404, `${level.noun} not found.`);
      const name = cleanStr(op.name);
      if (!name) throw httpError(400, `${level.noun} name is required.`);
      entry.name = name;
      if (level.parent && op.parentID !== undefined) {
        const parentID = resolve(op.parentID);
        if (!parentID) throw httpError(400, `${level.parent.noun} is required.`);
        requireParent(level, parentID);
        entry.parentID = parentID;
      }

    } else if (op.op === "delete") {
      const id = resolve(op.id);
      if (!state[levelKey].has(id)) throw httpError(404, `${level.noun} not found.`);
      subtreeOf(levelKey, id).forEach(({ levelKey: k, id: did }) => state[k].delete(did));

    } else {
      throw httpError(400, `Unknown change type "${op?.op}".`);
    }
  }

  // Diff the final state against the starting one — this naturally collapses
  // "create then delete" and "rename twice" into what actually needs writing.
  const writes = [];
  const touched = []; // created / renamed / moved entries, for the duplicate check
  const counts = { created: 0, renamed: 0, moved: 0, deleted: 0 };
  keys.forEach((k) => {
    state[k].forEach((v, id) => {
      const before = initial[k].get(id);
      if (!before) {
        writes.push({ type: "set", k, id, v }); counts.created++; touched.push([k, id]);
      } else if (before.name !== v.name || before.parentID !== v.parentID) {
        writes.push({ type: "update", k, id, v }); touched.push([k, id]);
        if (before.name !== v.name) counts.renamed++;
        if (before.parentID !== v.parentID) counts.moved++;
      }
    });
    initial[k].forEach((_, id) => {
      if (!state[k].has(id)) { writes.push({ type: "delete", k, id }); counts.deleted++; }
    });
  });

  if (writes.length === 0) throw httpError(400, "Nothing was changed.");
  if (counts.deleted > 0 && !canDelete) throw httpError(403, "Only an Owner or Admin can delete addresses.");

  // No two siblings (same parent, same level) may share a name — checked only
  // for entries this batch touched, so old duplicates never block an edit.
  const dupIndex = {};
  keys.forEach((k) => {
    const m = new Map();
    state[k].forEach((v) => {
      const key = `${v.parentID ?? ""}|${v.name.toLowerCase()}`;
      m.set(key, (m.get(key) || 0) + 1);
    });
    dupIndex[k] = m;
  });
  for (const [k, id] of touched) {
    const v = state[k].get(id);
    if (dupIndex[k].get(`${v.parentID ?? ""}|${v.name.toLowerCase()}`) > 1) {
      const level = LEVELS[k];
      throw httpError(
        409,
        level.parent
          ? `"${v.name}" already exists under that ${level.parent.noun.toLowerCase()}.`
          : `"${v.name}" already exists.`
      );
    }
  }

  // Write: creates first, then updates, then deletes, in Firestore batches.
  const order = { set: 0, update: 1, delete: 2 };
  writes.sort((a, b) => order[a.type] - order[b.type]);
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    writes.slice(i, i + BATCH_SIZE).forEach((w) => {
      const level = LEVELS[w.k];
      const ref = db.collection(level.collection).doc(w.id);
      const fields = { [level.nameField]: w.v?.name, ...(level.parent ? { [level.parent.field]: w.v?.parentID } : {}) };
      if (w.type === "set") batch.set(ref, { [level.idField]: w.id, ...fields });
      else if (w.type === "update") batch.update(ref, fields);
      else batch.delete(ref);
    });
    await batch.commit();
  }

  return { counts, ids: Object.fromEntries(tempMap) };
};