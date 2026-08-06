/**
 * Role utility — maps roleIDs to human-readable role names.
 *
 * roleID constants (from Firestore roles collection):
 *   Owner      → 1BX4V7M43t6barbPd4BP
 *   Admin      → 5bhRYMrDkjrs9VlFFY4u
 *   Driver     → Na0Jpt86nldSO5SjfcLa
 *   Supervisor → fFA8G2R2ANLbVsH00jlv
 */

export const ROLES = {
  OWNER:      "Owner",
  ADMIN:      "Admin",
  SUPERVISOR: "Supervisor",
  DRIVER:     "Driver",
};

export const ROLE_IDS = {
  OWNER:      "1BX4V7M43t6barbPd4BP",
  ADMIN:      "5bhRYMrDkjrs9VlFFY4u",
  DRIVER:     "Na0Jpt86nldSO5SjfcLa",
  SUPERVISOR: "fFA8G2R2ANLbVsH00jlv",
};

/**
 * Map a Firestore roleID → roleName.
 * Returns null if the roleID is unknown.
 */
export function roleIDToName(roleID) {
  const map = {
    [ROLE_IDS.OWNER]:      ROLES.OWNER,
    [ROLE_IDS.ADMIN]:      ROLES.ADMIN,
    [ROLE_IDS.DRIVER]:     ROLES.DRIVER,
    [ROLE_IDS.SUPERVISOR]: ROLES.SUPERVISOR,
  };
  return map[roleID] ?? null;
}

// Customer isn't a staff role — it has no login/JWT flow and isn't part of
// ROLE_IDS above, so it likely has no doc in the `roles` collection either.
// This is the ONE place its ID should live (nothing else in the backend or
// frontend should hardcode a separate copy of it).
const CUSTOMER_ROLE_ID = "9vD6ZU1s2qUtmyu0RXKD";

// In-memory cache so a live Firestore lookup only happens once per process,
// not on every request.
let _roleNameToIdCache = null;

/**
 * Resolve a role NAME -> Firestore roleID. This is the single source of
 * truth every other file (routes, controllers, and now the frontend via
 * the /api/users?role= endpoint) should go through, instead of copying
 * role IDs into their own files.
 *
 * Resolution order:
 *   1. The 4 known staff roles (ROLE_IDS above) — no DB call needed.
 *   2. "Customer" — the hardcoded constant above.
 *   3. Anything else — live query against the `roles` collection, matching
 *      on its `roleName` field, cached after first lookup.
 *
 * Returns null if the name can't be resolved anywhere.
 */
export async function resolveRoleID(roleName) {
  if (roleName === ROLES.OWNER)      return ROLE_IDS.OWNER;
  if (roleName === ROLES.ADMIN)      return ROLE_IDS.ADMIN;
  if (roleName === ROLES.DRIVER)     return ROLE_IDS.DRIVER;
  if (roleName === ROLES.SUPERVISOR) return ROLE_IDS.SUPERVISOR;
  if (roleName === "Customer")       return CUSTOMER_ROLE_ID;

  if (!_roleNameToIdCache) {
    const { db } = await import("../../config/firebaseConnection/firebase.js");
    const snap = await db.collection("roles").get();
    _roleNameToIdCache = {};
    snap.docs.forEach((d) => {
      const name = d.data().roleName;
      if (name) _roleNameToIdCache[name] = d.id;
    });
  }
  return _roleNameToIdCache[roleName] ?? null;
}

// Who is allowed to VIEW another role's user list, via GET /api/users?role=.
// Mirrors frontend/src/pages/Users.jsx's buildRoleTabs() visibleTo values —
// keep these two in sync by hand, same caveat as pagePermissions.js has for
// the sidebar/route gating.
export const ROLE_LIST_VIEWABLE_BY = {
  Customer:   [ROLES.OWNER, ROLES.ADMIN],
  [ROLES.DRIVER]:     [ROLES.OWNER, ROLES.ADMIN, ROLES.SUPERVISOR],
  [ROLES.SUPERVISOR]: [ROLES.OWNER, ROLES.ADMIN],
  [ROLES.ADMIN]:      [ROLES.OWNER],
};