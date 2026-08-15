import { db } from "../../config/firebaseConnection/firebase.js";

// ─────────────────────────────────────────────────────────────────────────
// Read-only lookup against the PH location dataset that already lives in
// this same Firestore project (customer-backend/controllers/location/
// location.controller.js reads the same 'provinces' and 'municipalities'
// collections for the registration address form — this does NOT create
// any new collection, it just reads what's already there).
//
// Purpose: give the admin Settings page a real, correctly-spelled list of
// provinces and cities/municipalities to pick "base area" from, instead of
// free-typed text that's one typo away from silently never matching.
//
// NOTE: this does not change how matching happens at booking time — that
// still runs the old substring check in customer-backend/utils/pricing.js.
// This only makes sure what admin *saves* is a real place name.
// ─────────────────────────────────────────────────────────────────────────

// In-memory cache — same reasoning as the customer backend's location
// cache: this data essentially never changes, so one fetch per cold start
// is enough. Cleared only on server restart.
let cache = null; // { options: [{ id, name, type }], loadedAt }

const loadOptions = async () => {
  const [provincesSnap, municipalitiesSnap] = await Promise.all([
    db.collection("provinces").get(),
    db.collection("municipalities").get(),
  ]);

  const provinces = provincesSnap.docs.map((doc) => ({
    id: doc.data().provinceID || doc.id,
    name: doc.data().provinceName,
    type: "province",
  }));

  const municipalities = municipalitiesSnap.docs.map((doc) => ({
    id: doc.data().municipalityID || doc.id,
    name: doc.data().municipalityName,
    type: "city", // covers both cities and municipalities, matching how the customer app's own tier is labeled
  }));

  const options = [...provinces, ...municipalities]
    .filter((o) => o.name)
    .sort((a, b) => a.name.localeCompare(b.name));

  cache = { options, loadedAt: Date.now() };
  return options;
};

// GET-style lookup: search is matched case-insensitively against the name,
// capped at 20 results so the dropdown stays usable while typing.
export const searchAreaOptions = async (search = "") => {
  const options = cache?.options || (await loadOptions());
  const q = search.trim().toLowerCase();
  if (!q) return options.slice(0, 20);
  return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 20);
};