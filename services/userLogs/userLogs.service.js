import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

export const getAllUserLogs = async () => {
  const snapshot = await db
    .collection("userLogs")
    .orderBy("loginDateTime", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      loginDateTime: data.loginDateTime?.toDate
        ? data.loginDateTime.toDate().toISOString()
        : data.loginDateTime ?? null,
      logoutDateTime: data.logoutDateTime?.toDate
        ? data.logoutDateTime.toDate().toISOString()
        : data.logoutDateTime ?? null,
    };
  });
};

export const getAllUserLogsArchive = async () => {
  const snapshot = await db
    .collection("userLogsArchive")
    .orderBy("archivedAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      loginDateTime: data.loginDateTime?.toDate
        ? data.loginDateTime.toDate().toISOString()
        : data.loginDateTime ?? null,
      logoutDateTime: data.logoutDateTime?.toDate
        ? data.logoutDateTime.toDate().toISOString()
        : data.logoutDateTime ?? null,
      archivedAt: data.archivedAt?.toDate
        ? data.archivedAt.toDate().toISOString()
        : data.archivedAt ?? null,
    };
  });
};

export const archiveUserLog = async (id) => {
  const logRef = db.collection("userLogs").doc(id);
  const logDoc = await logRef.get();

  if (!logDoc.exists) throw new Error("User log not found.");

  const logData = logDoc.data();

  await db.collection("userLogsArchive").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};
