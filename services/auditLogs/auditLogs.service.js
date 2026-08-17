import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

// Valid action values the frontend's AuditLog.jsx has badge styling for.
// Keep this in sync with typeBadgeDot/typeBadgeBg in that file if a new
// action is ever needed.
const VALID_ACTIONS = ["create", "update", "delete", "export", "auth", "system"];

// Writes one entry to the auditLogs collection. This is the single place
// anything in the backend should go through to log an action — previously
// nothing in the codebase actually wrote here, so getAllAuditLogs() always
// returned an empty list.
export const createAuditLog = async ({ action, description, userID = null }) => {
  if (!VALID_ACTIONS.includes(action)) {
    throw new Error(`Invalid action. Must be one of: ${VALID_ACTIONS.join(", ")}`);
  }
  if (!description) throw new Error("description is required.");

  const ref = await db.collection("auditLogs").add({
    action,
    description,
    userID, // uid of the staff member who performed the action (nullable)
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { id: ref.id, action, description, userID };
};

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

  await db.collection("auditLogsArchives").add({
    ...logData,
    originalId: id,
    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logRef.delete();
};