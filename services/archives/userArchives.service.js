import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { collectStorageUrls, deleteStorageFiles } from "../../utils/storage/storageFiles.js";
import { sendAccountRestoredEmail } from "../email/email.service.js";
import { syncStaffUser, STAFF_ROLES } from "../staffUser/staffUser.service.js";
import { resolveNotification } from "../notification/notification.service.js";

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
// Staff (Admin / Supervisor / Driver): deleteUser() removes their staffUser doc (the email -> userID lookup the admin
// login uses), so step 2 also puts it back from the restored role. Without it a restored staff member could not log in.
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
// with it, so that archive cannot be restored (there is no merge any more).
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
        throw new Error("This email already has a login under a different account, so this archived user cannot be restored.");
      }
      throw createErr;
    }
  }

  // ── 2. Restore user ──
  await db.collection("user").doc(originalId).set({
    ...originalData,
    status: "active",
  });

  // ── 2b. Staff only: bring back the staffUser doc the admin login looks up (no-op for customers) ──
  // Before the archive record is deleted, so a failure here leaves the archive in place and the restore can be retried.
  const staffAccessRestored = STAFF_ROLES.has(originalData.roleID)
    ? await syncStaffUser(originalId, originalData.roleID, originalData.email || "")
    : false;

  // ── 3. Delete the archive record ──
  await archiveRef.delete();

  // The customer's "please check my archived account" request (written by the customer backend) is answered now:
  // clear it from every Owner/Admin's bell. Never blocks the restore.
  resolveNotification("archive_appeal", originalId).catch((err) => console.error("[USER ARCHIVE] resolve appeal failed:", err.message));

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

  return { authEnabled, authRecreated, staffAccessRestored, emailSent };
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
// Profile docs are looked up by the archived uid only, so they can never include
// another account's docs. As a second guard, any file still referenced by another
// live record is skipped (see urlStillInUse).
// The requests this user submitted (profile edits, new license / ID photos). Only an archive that is being
// permanently deleted ever gets here.
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

  // Nothing left to review: clear any open "check my archived account" request from the staff bells. Never blocks the delete.
  resolveNotification("archive_appeal", originalId).catch((err) => console.error("[USER ARCHIVE] resolve appeal failed:", err.message));

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