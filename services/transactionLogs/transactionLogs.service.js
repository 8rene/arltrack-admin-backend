import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { normalizeMethod, nullIfSentinel } from "../paymentEntries/paymentEntries.mapper.js";

const VALID_TYPES   = ["Payment", "Refund", "Deposit", "DepositReturn", "Discount"];
const VALID_STATUSES = ["Success", "Failed", "Pending", "Refunded", "Rejected"];

// Writes one entry to the transactionLogs collection. This is the single
// place anything in the backend should go through to log a completed
// money event — write at the moment money actually moves or a request is
// finally resolved (Refunded/Failed/Rejected), not at every intermediate
// state change (e.g. a refund sitting at "Pending" does NOT get an entry
// here — see refundRequests for that in-progress state).
//
// This ledger is money-only: every entry is money that moved between the customer and the business.
// Company costs (e.g. a maintenance bill) are NOT logged here -- maintenance.totalCost is their only copy.
// Every type logs one final settled amount -- never a delta -- so a later correction/reversal is its own
// separate entry with its own full amount, not a diff against a previous one.
//
// Never throws — a logging failure should never block the real action
// (a payment settling, a discount being applied) from completing. Callers
// should call this without awaiting if they don't want a logging hiccup
// to delay their response, same convention as recordAudit()/createAuditLog().
export const createTransactionLog = async ({
  bookingID,
  paymentID,
  userID,
  type,
  amount,
  status,
  paymentMethod = null,    // anything the caller has ("GCash", "Bank Transfer", "InStore" ...): stored as a method code
  referenceNumber = null,  // "", "—", "N/A" are stored as null
  description = "",
  performedBy = null,
  // Link to the record that caused this entry. At most one is set; each has its own column:
  refundReqID = null,     // a refundRequests doc
  paymentEntryID = null,  // the paymentEntries row that was settled
  penaltyID = null,       // a penalties doc, when the payment covered exactly ONE penalty (several -> null; the
                          //   per-penalty rows are the paymentEntries that share a groupID)
  // Optional idempotency key: written with create() to a doc of exactly this id,
  // so a repeat attempt to log the same event is a harmless no-op instead of a
  // duplicate row. Omit for one-off entries.
  logID = null,
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

    // Same vocabulary as paymentEntries.method: gcash | maya | qrph | cash | bank_transfer, or null when the
    // money did not move through a method (e.g. a deduction from the held deposit -- the description says so).
    const { method, unmapped } = normalizeMethod(paymentMethod);
    if (unmapped) console.warn(`createTransactionLog: unknown payment method "${unmapped}" stored as null`);

    const ref = logID ? db.collection("transactionLogs").doc(logID) : db.collection("transactionLogs").doc();
    const payload = {
      transactionLogsID: ref.id,
      bookingID: bookingID || null,
      paymentID: paymentID || null,
      userID: userID || null,
      refundReqID,
      paymentEntryID,
      penaltyID,
      type,
      amount: Number(amount) || 0,
      status,
      paymentMethod: method,
      referenceNumber: nullIfSentinel(referenceNumber),
      description,
      performedBy,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (logID) {
      try {
        await ref.create(payload); // ALREADY_EXISTS (code 6) → this event was already logged
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(e.message || ""))) return ref.id;
        throw e;
      }
    } else {
      await ref.set(payload);
    }
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