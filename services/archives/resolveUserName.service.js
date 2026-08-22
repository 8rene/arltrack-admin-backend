import { db } from "../../config/firebaseConnection/firebase.js";

/**
 * resolveUserName.service.js
 *
 * Several archive collections (auditLogsArchives, transactionLogArchives,
 * reviewsArchives, ...) only store a raw userID on the doc — same as their
 * live counterparts (auditLogs, transactionLogs, ...). The admin UI wants a
 * human name there, not a Firestore doc ID, so this is the one place that
 * resolves userID -> display name.
 *
 * Mirrors the resolution order already used by payments.service.js's
 * resolveCustomerName(): userDetails (firstName + lastName) first, then
 * user.username / user.email as a fallback, then the raw ID if nothing
 * matches (a resolvable ID is still more useful than a blank cell).
 *
 * Results are cached per-call-batch by the caller (pass a Map) so a page
 * with many rows for the same staff/customer doesn't re-fetch per row.
 */
export const resolveUserName = async (userID) => {
  if (!userID) return "—";
  try {
    const detailsSnap = await db
      .collection("userDetails")
      .where("userID", "==", userID)
      .limit(1)
      .get();
    if (!detailsSnap.empty) {
      const { firstName = "", lastName = "" } = detailsSnap.docs[0].data();
      const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
      if (fullName) return fullName;
    }

    const userDoc = await db.collection("user").doc(userID).get();
    if (userDoc.exists) {
      const { username = "", email = "" } = userDoc.data();
      if (username || email) return username || email;
    }

    return userID; // last resort — still better than a blank cell
  } catch {
    return userID;
  }
};

/**
 * Batch version — resolves a list of userIDs at once and returns a
 * { [userID]: displayName } map, so callers building a list of rows only
 * do one round of lookups instead of one per row.
 */
export const resolveUserNames = async (userIDs = []) => {
  const uniqueIDs = [...new Set(userIDs.filter(Boolean))];
  const entries = await Promise.all(
    uniqueIDs.map(async (id) => [id, await resolveUserName(id)])
  );
  return Object.fromEntries(entries);
};