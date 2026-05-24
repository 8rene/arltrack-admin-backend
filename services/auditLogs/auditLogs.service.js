import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

export const getAllAuditLogs = async () => {
  const snapshot = await db
    .collection("auditLogs")
    .orderBy("createdAt", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate
        ? data.createdAt.toDate().toISOString()
        : data.createdAt ?? null,
    };
  });
};

export const archiveAuditLog = async (id) => {
  const logRef = db.collection("auditLogs").doc(id);
  const logDoc = await logRef.get();

  if (!logDoc.exists) throw new Error("Audit log not found.");

  const logData = logDoc.data();

  await db.collection("auditLogsArchive").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};
