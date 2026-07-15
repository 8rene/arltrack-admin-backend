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