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