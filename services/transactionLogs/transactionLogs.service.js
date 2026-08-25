import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";

const VALID_TYPES   = ["Payment", "Refund", "Deposit", "Discount"];
const VALID_STATUSES = ["Success", "Failed", "Pending", "Refunded", "Rejected"];

// Writes one entry to the transactionLogs collection. This is the single
// place anything in the backend should go through to log a completed
// money event — write at the moment money actually moves or a request is
// finally resolved (Refunded/Failed/Rejected), not at every intermediate
// state change (e.g. a refund sitting at "Pending" does NOT get an entry
// here — see refundRequests for that in-progress state).
//
// Never throws — a logging failure should never block the real action
// (a payment settling, a discount being applied) from completing. Callers
// should call this without awaiting if they don't want a logging hiccup
// to delay their response, same convention as recordAudit()/createAuditLog().
export const createTransactionLog = async ({
  bookingID,
  paymentID,
  refundRequestID = null,
  userID,
  type,
  amount,
  status,
  paymentMethod = "",
  referenceNumber = "",
  description = "",
  performedBy = null,
}) => {
  try {
    if (!VALID_TYPES.includes(type)) {
      console.error(`createTransactionLog: invalid type "${type}"`);
      return null;
    }
    if (!VALID_STATUSES.includes(status)) {
      console.error(`createTransactionLog: invalid status "${status}"`);
      return null;
    }

    const ref = db.collection("transactionLogs").doc();
    await ref.set({
      transactionLogsID: ref.id,
      bookingID: bookingID || null,
      paymentID: paymentID || null,
      refundRequestID,
      userID: userID || null,
      type,
      amount: Number(amount) || 0,
      status,
      paymentMethod,
      referenceNumber,
      description,
      performedBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return ref.id;
  } catch (err) {
    console.error("createTransactionLog error:", err.message);
    return null;
  }
};

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