import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// Writes one userLogs doc at the moment a session starts. Returns the new
// doc's ID so the caller (auth.controller.js) can hand it back to the
// frontend, which sends it back on logout so we know which session to close.
export const createUserLog = async ({ uID, username }) => {
  const ref = await db.collection("userLogs").add({
    uID,
    username: username || "",
    loginDateTime: admin.firestore.FieldValue.serverTimestamp(),
    logoutDateTime: null,
    sessionDuration: 0,
  });
  return ref.id;
};

// Closes an existing userLogs doc — sets logoutDateTime and computes
// sessionDuration (in seconds) from the recorded loginDateTime. Silently
// no-ops if the doc is missing (e.g. already archived) rather than
// throwing, since this is called from logout, which should never fail the
// user-facing logout action just because logging hiccuped.
export const closeUserLog = async (logID) => {
  if (!logID) return;

  const logRef = db.collection("userLogs").doc(logID);
  const logDoc = await logRef.get();
  if (!logDoc.exists) return;

  const data = logDoc.data();
  const loginDateTime = data.loginDateTime?.toDate
    ? data.loginDateTime.toDate()
    : new Date(data.loginDateTime);

  const now = new Date();
  const sessionDuration = Math.max(
    0,
    Math.round((now.getTime() - loginDateTime.getTime()) / 1000)
  ); // seconds

  await logRef.update({
    logoutDateTime: admin.firestore.FieldValue.serverTimestamp(),
    sessionDuration,
  });
};

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

  await db.collection("userLogArchives").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};