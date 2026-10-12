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
