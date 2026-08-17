import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllUserArchives = async () => {
  const snapshot = await db
    .collection("userArchive")
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

// ── HELPERS: find linked archive docs by originalId (the deleted user's uid) ──
const findLinkedDetailsArchives = async (originalId) => {
  if (!originalId) return [];
  const snap = await db.collection("userDetailsArchive").where("originalId", "==", originalId).get();
  return snap.docs;
};

const findLinkedAddressArchives = async (originalId) => {
  if (!originalId) return [];
  const snap = await db.collection("userAddressArchive").where("originalId", "==", originalId).get();
  return snap.docs;
};

const findLinkedDocumentArchives = async (originalId) => {
  if (!originalId) return [];
  const snap = await db.collection("userDocumentArchive").where("originalId", "==", originalId).get();
  return snap.docs;
};

// ── RESTORE (cascade) ─────────────────────────────────────────────────────────
// 1. Restore user → user collection
// 2. Restore linked userDetailsArchive entries → userDetails collection
// 3. Restore linked userAddressArchive entries → userAddress collection
// 4. Restore linked userDocumentArchive entries → userDocument collection
// 5. Delete all four archive records
//
// NOTE — Firebase Auth: deleteUser() permanently deletes the Auth account
// (admin.auth().deleteUser), which cannot be undone via the Admin SDK the
// same way Firestore docs can. Restoring here brings back the Firestore
// profile/details/address/documents, but the customer will need to sign up
// again (or an admin recreates the Auth account with the same uid) before
// they can log in. authRestoreRequired flags this so the UI can warn about it.
export const restoreUserArchive = async (userArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("userArchive").doc(userArchivesId);
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

  // ── 2. Restore linked userDetails ──
  const detailsArchiveDocs = await findLinkedDetailsArchives(originalId);
  for (const d of detailsArchiveDocs) {
    const { originalId: _o, archivedAt: _a, ...detailsData } = d.data();
    await db.collection("userDetails").add({
      ...detailsData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 3. Restore linked userAddress ──
  const addressArchiveDocs = await findLinkedAddressArchives(originalId);
  for (const d of addressArchiveDocs) {
    const { originalId: _o, archivedAt: _a, ...addressData } = d.data();
    await db.collection("userAddress").add({
      ...addressData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 4. Restore linked userDocument ──
  const documentArchiveDocs = await findLinkedDocumentArchives(originalId);
  for (const d of documentArchiveDocs) {
    const { originalId: _o, archivedAt: _a, ...documentData } = d.data();
    await db.collection("userDocument").add({
      ...documentData,
      restoredAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // ── 5. Delete all archive records (batch) ──
  const batch = db.batch();
  batch.delete(archiveRef);
  for (const d of detailsArchiveDocs)  batch.delete(d.ref);
  for (const d of addressArchiveDocs)  batch.delete(d.ref);
  for (const d of documentArchiveDocs) batch.delete(d.ref);
  await batch.commit();

  return {
    restoredDetails:  detailsArchiveDocs.length,
    restoredAddress:  addressArchiveDocs.length,
    restoredDocument: documentArchiveDocs.length,
    authRestoreRequired: true,
  };
};

// ── PERMANENT DELETE (cascade) ────────────────────────────────────────────────
// Deletes the userArchive + its linked userDetailsArchive + userAddressArchive
// + userDocumentArchive entries.
export const deleteUserArchive = async (userArchivesId) => {
  const archiveRef = db.collection("userArchive").doc(userArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived user not found.");

  const data = archiveDoc.data();
  const originalId = data.originalId;

  const detailsArchiveDocs  = await findLinkedDetailsArchives(originalId);
  const addressArchiveDocs  = await findLinkedAddressArchives(originalId);
  const documentArchiveDocs = await findLinkedDocumentArchives(originalId);

  const batch = db.batch();
  batch.delete(archiveRef);
  for (const d of detailsArchiveDocs)  batch.delete(d.ref);
  for (const d of addressArchiveDocs)  batch.delete(d.ref);
  for (const d of documentArchiveDocs) batch.delete(d.ref);
  await batch.commit();

  return {
    deletedDetails:  detailsArchiveDocs.length,
    deletedAddress:  addressArchiveDocs.length,
    deletedDocument: documentArchiveDocs.length,
  };
};