import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

export const getAllTransactionLogs = async () => {
  const snapshot = await db
    .collection("transactionLogs")
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

export const archiveTransactionLog = async (id) => {
  const logRef = db.collection("transactionLogs").doc(id);
  const logDoc = await logRef.get();

  if (!logDoc.exists) throw new Error("Transaction log not found.");

  const logData = logDoc.data();

  await db.collection("transactionLogArchives").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};