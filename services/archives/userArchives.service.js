import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllUserArchives = async () => {
  const snapshot = await db
    .collection("userArchives")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      userArchivesId: doc.id,
      ...data,
      createdAt:  toISO(data.createdAt),
      archivedAt: toISO(data.archivedAt),
      restoredAt: toISO(data.restoredAt),
    };
  });
};

// ── HELPERS: find LIVE docs by userID (the deleted user's uid) ──────────────
// userDetails/userAddress/userDocument are no longer archived into their own
// collections at soft-delete time (see deleteUser() in
// controllers/user/user.controller.js) — they stay live and untouched while
// a user sits in userArchives. These helpers find them by userID so
// deleteUserArchive() can permanently purge them when that time comes.
const findLiveUserDetails = async (userID) => {
  if (!userID) return [];
  const snap = await db.collection("userDetails").where("userID", "==", userID).get();
  return snap.docs;
};

const findLiveUserAddress = async (userID) => {
  if (!userID) return [];
  const snap = await db.collection("userAddress").where("userID", "==", userID).get();
  return snap.docs;
};

const findLiveUserDocument = async (userID) => {
  if (!userID) return [];
  const snap = await db.collection("userDocument").where("userID", "==", userID).get();
  return snap.docs;
};

// ── RESTORE ───────────────────────────────────────────────────────────────
// 1. Restore user → user collection
// 2. Delete the userArchives record
//
// userDetails/userAddress/userDocument need no restore step — they were
// never removed in the first place (see deleteUser()), so there's nothing
// to bring back for them.
//
// NOTE — Firebase Auth: deleteUser() permanently deletes the Auth account
// (admin.auth().deleteUser), which cannot be undone via the Admin SDK the
// same way Firestore docs can. Restoring here brings back the Firestore
// user profile, but the customer will need to sign up again (or an admin
// recreates the Auth account with the same uid) before they can log in.
// authRestoreRequired flags this so the UI can warn about it.
export const restoreUserArchive = async (userArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("userArchives").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  const {
    originalId,
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  // ── 1. Restore user ──
  const userActiveRef = originalId
    ? db.collection("user").doc(originalId)
    : db.collection("user").doc();

  await userActiveRef.set({
    ...originalData,
    status: "active",
    restoredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ── 2. Delete the archive record ──
  await archiveRef.delete();

  return {
    authRestoreRequired: true,
  };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────
// This is the point of no return for a deleted account: deletes the
// userArchives record itself, plus the live userDetails/userAddress/
// userDocument docs that were deliberately left untouched at soft-delete
// time (see deleteUser()). Nothing archives them first — once this runs,
// that data is genuinely gone.
export const deleteUserArchive = async (userArchivesId) => {
  const archiveRef = db.collection("userArchives").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  const data = archiveDoc.data();
  const originalId = data.originalId;

  const detailsDocs  = await findLiveUserDetails(originalId);
  const addressDocs  = await findLiveUserAddress(originalId);
  const documentDocs = await findLiveUserDocument(originalId);

  const batch = db.batch();
  batch.delete(archiveRef);
  for (const d of detailsDocs)  batch.delete(d.ref);
  for (const d of addressDocs)  batch.delete(d.ref);
  for (const d of documentDocs) batch.delete(d.ref);
  await batch.commit();

  return {
    deletedDetails:  detailsDocs.length,
    deletedAddress:  addressDocs.length,
    deletedDocument: documentDocs.length,
  };
};

// ── MERGE INTO A NEWER ACCOUNT ───────────────────────────────────────────────
// Use when a customer was archived (their Auth account deleted), signed up
// again with the same email and got a NEW uid, and the old history should now
// belong to that new account. The NEW uid stays; everything that pointed at
// the OLD uid is re-pointed to it. Nothing is restored under the old uid, so
// there are never two `user` docs for one email.
//
// Safe to re-run: the archive record is deleted LAST, so if a batch fails
// midway the record is still there and running the merge again just picks up
// whatever still points at the old uid.

// [collection, field] pairs that hold the old uid.
const USER_ID_LINKS = [
  ["bookings", "userID"], ["bookings", "driverID"],
  ["refundRequests", "userID"], ["penalties", "userID"], ["reviews", "userID"],
  ["transactionLogs", "userID"], ["sessionLogs", "userID"], ["userLogs", "userID"],
  ["notifications", "userID"], ["editRequests", "userID"], ["idResubmitRequests", "userID"],
  ["auditLogs", "userID"],
  ["bookingArchives", "userID"], ["refundArchives", "userID"], ["penaltyArchives", "userID"],
  ["reviewsArchives", "userID"], ["transactionLogArchives", "userID"],
  ["sessionLogArchives", "userID"], ["userLogArchives", "userID"], ["auditLogsArchives", "userID"],
  ["user", "referredBy"],
];

// Profile docs: the new account already has its own from signup, so those win.
// Old ones are only moved across when the new account has none.
const PROFILE_COLLECTIONS = ["userDetails", "userAddress", "userDocument"];

const commitInChunks = async (ops) => {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((fn) => fn(batch));
    await batch.commit();
  }
};

export const findMergeCandidate = async (userArchivesId) => {
  const archiveDoc = await db.collection("userArchives").doc(userArchivesId).get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");
  const { email, originalId } = archiveDoc.data();
  if (!email) return null;

  const snap = await db.collection("user").where("email", "==", email).get();
  const match = snap.docs.find((d) => d.id !== originalId);
  if (!match) return null;
  const u = match.data();
  return { userID: match.id, email: u.email, username: u.username || "", createdAt: toISO(u.createdAt) };
};

export const mergeUserArchive = async (userArchivesId, targetUserID, mergedBy = "admin") => {
  const archiveRef = db.collection("userArchives").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  const archived = archiveDoc.data();
  const oldUID = archived.originalId;
  if (!oldUID) throw new Error("Archived record has no original user ID to merge from.");
  if (!targetUserID) throw new Error("Target user ID is required.");
  if (targetUserID === oldUID) throw new Error("Cannot merge an account into itself.");

  const targetRef = db.collection("user").doc(targetUserID);
  const targetDoc = await targetRef.get();
  if (!targetDoc.exists) throw new Error("Target account not found.");

  const target = targetDoc.data();
  if ((target.email || "").toLowerCase() !== (archived.email || "").toLowerCase()) {
    throw new Error("Emails do not match — only accounts with the same email can be merged.");
  }
  if (target.roleID !== archived.roleID) {
    throw new Error("Roles do not match — only accounts with the same role can be merged.");
  }

  const counts = {};
  let referralsMoved = 0;

  // 1. Re-point every link from the old uid to the new one.
  for (const [col, field] of USER_ID_LINKS) {
    const snap = await db.collection(col).where(field, "==", oldUID).get();
    if (snap.empty) continue;
    counts[`${col}.${field}`] = snap.size;
    if (col === "user" && field === "referredBy") referralsMoved = snap.size;
    await commitInChunks(snap.docs.map((d) => (b) => b.update(d.ref, { [field]: targetUserID })));
  }

  // 2. Profile docs — keep the new account's own, move old ones only if missing.
  const profileKept = [];
  for (const col of PROFILE_COLLECTIONS) {
    const [oldSnap, newSnap] = await Promise.all([
      db.collection(col).where("userID", "==", oldUID).get(),
      db.collection(col).where("userID", "==", targetUserID).limit(1).get(),
    ]);
    if (oldSnap.empty) continue;
    if (newSnap.empty) {
      counts[`${col}.userID`] = oldSnap.size;
      await commitInChunks(oldSnap.docs.map((d) => (b) => b.update(d.ref, { userID: targetUserID })));
    } else {
      profileKept.push(col); // old doc left untouched, nothing overwritten or deleted
    }
  }

  // 3. Stamp the surviving account, carry over referral counts, drop the archive record.
  await targetRef.update({
    mergedFromUserIDs: admin.firestore.FieldValue.arrayUnion(oldUID),
    mergedAt: admin.firestore.FieldValue.serverTimestamp(),
    mergedBy,
    ...(referralsMoved ? { referralCount: admin.firestore.FieldValue.increment(referralsMoved) } : {}),
  });
  await archiveRef.delete();

  return { oldUserID: oldUID, newUserID: targetUserID, repointed: counts, profileKeptOnNewAccount: profileKept, referralsMoved };
};