import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { collectStorageUrls, deleteStorageFiles } from "../../utils/storage/storageFiles.js";
import { sendAccountRestoredEmail } from "../email/email.service.js";

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
      originalId: doc.id, // response only (the ID is no longer stored as a field)
      ...data,
      createdAt:  toISO(data.createdAt),
      archivedAt: toISO(data.archivedAt),
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
// 1. Bring the Firebase Auth login back
// 2. Restore user → user collection
// 3. Delete the userArchives record
// 4. Email the customer that their account is back
//
// userDetails/userAddress/userDocument need no restore step — they were
// never removed in the first place (see deleteUser()), so there's nothing
// to bring back for them.
//
// Firebase Auth: deleteUser() only DISABLES the login (it keeps the same uid, email and password), so restoring
// just switches it back on and the customer signs in as before. Archives made BEFORE that change had their login
// deleted: for those it is recreated here under the SAME uid but without a password, and the email tells the
// customer to use "Forgot password". The Auth step goes FIRST so a failure leaves the archive untouched and the
// restore can simply be retried.
//
// If an old-style archive's customer already signed up again with the same email, Auth refuses a second account
// with it — use Merge instead (mergeUserArchive below).
export const restoreUserArchive = async (userArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("userArchives").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  // The archive's document ID IS the user's uid.
  const originalId = archiveDoc.id;
  const {
    archivedAt,
    archivedBy,
    restoredAt,
    restoredBy: _rb,
    ...originalData
  } = archiveDoc.data();

  // ── 1. Bring the login back ──
  let authEnabled = false;   // the disabled login was switched back on (same password)
  let authRecreated = false; // an older archive: the login had been deleted, so it was created again (no password)
  try {
    await admin.auth().updateUser(originalId, { disabled: false });
    authEnabled = true;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    try {
      await admin.auth().createUser({
        uid: originalId,
        email: originalData.email,
        emailVerified: !!originalData.isVerified,
        disabled: false,
      });
      authRecreated = true;
    } catch (createErr) {
      if (createErr.code === "auth/email-already-exists") {
        throw new Error("This email already has a login under a different account. Use Merge instead of Restore.");
      }
      throw createErr;
    }
  }

  // ── 2. Restore user ──
  await db.collection("user").doc(originalId).set({
    ...originalData,
    status: "active",
  });

  // ── 3. Delete the archive record ──
  await archiveRef.delete();

  // ── 4. Tell the customer (never blocks the restore) ──
  let emailSent = false;
  if (originalData.email) {
    try {
      const r = await sendAccountRestoredEmail({
        toEmail: originalData.email,
        toName: originalData.username,
        needsPasswordReset: authRecreated,
      });
      emailSent = !!r.success;
    } catch (err) {
      console.error("[USER ARCHIVE] restore email failed:", err.message);
    }
  }

  return { authEnabled, authRecreated, emailSent };
};

// ── PERMANENT DELETE ─────────────────────────────────────────────────────
// This is the point of no return for a deleted account: deletes the
// userArchives record itself, plus the live userDetails/userAddress/
// userDocument docs that were deliberately left untouched at soft-delete
// time (see deleteUser()), and the user's editRequests / idResubmitRequests
// (deleteUser() only rejects the pending ones; they are deleted here).
// Nothing archives them first — once this runs, that data is genuinely gone.
//
// Storage files (license photo, ID photo, ID selfie, the photos on ID
// resubmit requests, profile picture) are deleted only after the database
// records that point at them are gone, and the archive record goes last, so a
// failed run can be repeated. A file that cannot be deleted is counted in
// failedFiles and never blocks the rest. Only files of THIS bucket are touched.
//
// Merge safety: mergeUserArchive() re-points the old account's profile docs to
// the new uid and deletes the archive record, so a merged account never reaches
// this function. Profile docs are looked up by the archived uid only, so they
// can never include the surviving account's docs. As a second guard, any file
// still referenced by another live record is skipped (see urlStillInUse).
// The requests this user submitted (profile edits, new license / ID photos). A merge re-points them to the new account,
// so only an archive that is being permanently deleted ever gets here.
const findLiveRequests = async (userID) => {
  if (!userID) return { edits: [], ids: [] };
  const [edits, ids] = await Promise.all([
    db.collection("editRequests").where("userID", "==", userID).get(),
    db.collection("idResubmitRequests").where("userID", "==", userID).get(),
  ]);
  return { edits: edits.docs, ids: ids.docs };
};

// Places a Storage file of a user can still be referenced from.
const FILE_REFERENCES = [
  ["user", "profileImage"],
  ["userDocument", "documentImageUrl"], ["userDocument", "driverLicenseUrl"], ["userDocument", "selfieWithIdUrl"],
  ["idResubmitRequests", "newLicenseUrl"], ["idResubmitRequests", "newDocumentUrl"], ["idResubmitRequests", "newSelfieUrl"],
];

// true when a record that is NOT being purged still points at this file
const urlStillInUse = async (url, purgedPaths) => {
  const snaps = await Promise.all(FILE_REFERENCES.map(([col, field]) => db.collection(col).where(field, "==", url).get()));
  return snaps.some((snap) => snap.docs.some((d) => !purgedPaths.has(d.ref.path)));
};

export const deleteUserArchive = async (userArchivesId) => {
  const archiveRef = db.collection("userArchives").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  const data = archiveDoc.data();
  const originalId = archiveDoc.id; // the archive's document ID is the user's uid

  const detailsDocs  = await findLiveUserDetails(originalId);
  const addressDocs  = await findLiveUserAddress(originalId);
  const documentDocs = await findLiveUserDocument(originalId);
  const { edits: editDocs, ids: idRequestDocs } = await findLiveRequests(originalId);

  const purgeDocs = [...detailsDocs, ...addressDocs, ...documentDocs, ...editDocs, ...idRequestDocs];
  const purgedPaths = new Set([archiveRef.path, ...purgeDocs.map((d) => d.ref.path)]);

  let deletedFiles = 0;
  let failedFiles = 0;
  // Deletes the files in `urls` that nothing outside the purge still uses. A failure never blocks the rest.
  const removeFiles = async (urls) => {
    const keep = [];
    for (const url of urls) {
      try {
        if (!(await urlStillInUse(url, purgedPaths))) keep.push(url);
      } catch (err) {
        console.error("[USER ARCHIVE] could not check file usage, keeping file:", err.message);
      }
    }
    if (!keep.length) return;
    const r = await deleteStorageFiles(keep);
    deletedFiles += r.deleted;
    failedFiles += r.failed;
  };

  // Records go in chunks (a batch takes at most 500 writes); each chunk's files go right after it is committed, and the
  // archive record goes LAST. So if something fails midway the archive is still there and the same delete can be run
  // again, and no file is ever left behind for a record that is already gone.
  for (let i = 0; i < purgeDocs.length; i += 400) {
    const part = purgeDocs.slice(i, i + 400);
    const batch = db.batch();
    part.forEach((d) => batch.delete(d.ref));
    await batch.commit();

    const urls = new Set();
    part.forEach((d) => collectStorageUrls(d.data(), urls)); // license / ID photo, selfie, photos on ID resubmit requests
    await removeFiles(urls);
  }

  // The login was only DISABLED when the account was archived (see deleteUser()); this is the point of no return, so
  // delete it now. That also frees the email for a new signup. Archives made before that change have no login left,
  // which is fine. Any other failure stops here, BEFORE the archive record goes, so the same delete can be run again.
  let deletedLogin = false;
  try {
    await admin.auth().deleteUser(originalId);
    deletedLogin = true;
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
  }

  await archiveRef.delete();
  await removeFiles(collectStorageUrls(data)); // the profile picture on the archived user copy

  return {
    deletedDetails:  detailsDocs.length,
    deletedAddress:  addressDocs.length,
    deletedDocument: documentDocs.length,
    deletedEditRequests:  editDocs.length,
    deletedIdRequests:    idRequestDocs.length,
    deletedLogin,
    deletedFiles,
    failedFiles,
  };
};

// ── MERGE INTO A NEWER ACCOUNT ───────────────────────────────────────────────
// Use when a customer was archived (their Auth account deleted), signed up
// again with the same email and got a NEW uid, and the old history should now
// belong to that new account. The NEW uid stays; everything that pointed at
// the OLD uid is re-pointed to it. Nothing is restored under the old uid, so
// there are never two `user` docs for one email.
//
// WHY THE NEW uid IS THE ONE THAT SURVIVES (and the old uid is not brought back):
// - A customer's login (Firebase Auth) is tied to a uid, and user/{uid} is keyed by that same uid. When the customer
//   was archived, their old Auth account was permanently deleted (see the note above restoreUserArchive), so nobody
//   can log in as the old uid any more. Their new login belongs to the NEW uid, which already has its own user doc.
// - Restoring the old uid as the main account would leave a user doc with no matching login. An admin would then have
//   to recreate that login by hand under the old uid and delete the new account, and until then the customer could
//   not sign in with the account they actually use.
// - Moving the history to the new uid avoids all of that: the old history gets re-pointed (USER_ID_LINKS below), the
//   new account and its login are never touched, and the old archive record is deleted once everything has moved.
//   The old uid therefore stops existing anywhere after a merge, which is the intent.
//
// Safe to re-run: the archive record is deleted LAST, so if a batch fails
// midway the record is still there and running the merge again just picks up
// whatever still points at the old uid.

// [collection, field] pairs that hold the old uid.
const USER_ID_LINKS = [
  ["bookings", "userID"], ["bookings", "driverID"],
  ["driverAssignments", "driverID"], ["cancellationRequests", "userID"],
  ["refundRequests", "userID"], ["penalties", "userID"], ["reviews", "userID"],
  ["payments", "userID"], ["paymentEntries", "userID"], ["paymentsArchives", "userID"],
  ["transactionLogs", "userID"], ["sessionLogs", "userID"],
  ["notifications", "userID"], ["editRequests", "userID"], ["idResubmitRequests", "userID"],
  ["auditLogs", "userID"],
  ["bookingArchives", "userID"], ["refundArchives", "userID"], ["penaltyArchives", "userID"],
  ["reviewsArchives", "userID"], ["transactionLogArchives", "userID"],
  ["sessionLogArchives", "userID"], ["auditLogsArchives", "userID"],
  // rows archived with a booking: they come back with the old uid unless re-pointed too
  ["paymentEntryArchives", "userID"], ["cancellationRequestArchives", "userID"], ["driverAssignmentArchives", "driverID"],
  ["referrals", "referrerUserID"], ["referrals", "referredUserID"],
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
  const { email } = archiveDoc.data();
  const originalId = archiveDoc.id;
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
  const oldUID = archiveDoc.id; // the archive's document ID is the old uid
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
    if (col === "referrals" && field === "referrerUserID") referralsMoved = snap.size;
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

  // 3. Stamp the surviving account and drop the archive record. (Referrals need no
  // separate counter — they were re-pointed above and are counted from the table.)
  await targetRef.update({
    mergedFromUserIDs: admin.firestore.FieldValue.arrayUnion(oldUID),
    mergedAt: admin.firestore.FieldValue.serverTimestamp(),
    mergedBy,
  });
  await archiveRef.delete();

  return { oldUserID: oldUID, newUserID: targetUserID, repointed: counts, profileKeptOnNewAccount: profileKept, referralsMoved };
};