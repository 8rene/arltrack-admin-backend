import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { normalizeMethod, nullIfSentinel } from "../paymentEntries/paymentEntries.mapper.js";

const VALID_TYPES   = ["Payment", "Refund", "Deposit", "DepositReturn", "Discount", "Expense"];
const VALID_STATUSES = ["Success", "Failed", "Pending", "Refunded", "Rejected"];

// Writes one entry to the transactionLogs collection. This is the single
// place anything in the backend should go through to log a completed
// money event — write at the moment money actually moves or a request is
// finally resolved (Refunded/Failed/Rejected), not at every intermediate
// state change (e.g. a refund sitting at "Pending" does NOT get an entry
// here — see refundRequests for that in-progress state).
//
// "Expense" is the one type that isn't customer-facing — a company cost
// (e.g. a maintenance bill) with no booking/payment/customer attached, so
// bookingID/paymentID/userID are left null for those entries. Every type
// here, Expense included, logs one final settled amount — never a delta —
// so a later correction/reversal is its own separate entry with its own
// full amount, not a diff against a previous one.
//
// Never throws — a logging failure should never block the real action
// (a payment settling, a discount being applied) from completing. Callers
// should call this without awaiting if they don't want a logging hiccup
// to delay their response, same convention as recordAudit()/createAuditLog().
export const createTransactionLog = async ({
  bookingID,
  paymentID,
  refundRequestID = null, // DEPRECATED input alias of refundReqID (kept so an old caller keeps working). Never stored under this name.
  userID,
  type,
  amount,
  status,
  paymentMethod = "",
  referenceNumber = "",
  description = "",
  performedBy = null,
  // The link to the record that caused this log. Set AT MOST ONE of these (there is no generic refID/refCollection pair):
  refundReqID = null,     // refundRequests doc (type "Refund" via a refund request)
  paymentEntryID = null,  // paymentEntries doc that was settled (type "Payment")
  maintenanceID = null,   // maintenance doc (type "Expense")
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

    // Old callers still pass refundRequestID: it is the same thing as refundReqID.
    if (refundRequestID && !refundReqID) refundReqID = refundRequestID;

    const ref = logID ? db.collection("transactionLogs").doc(logID) : db.collection("transactionLogs").doc();
    const payload = {
      transactionLogsID: ref.id,
      bookingID: bookingID || null,
      paymentID: paymentID || null,
      userID: userID || null,
      refundReqID: refundReqID || null,
      paymentEntryID: paymentEntryID || null,
      maintenanceID: maintenanceID || null,
      type,
      amount: Number(amount) || 0,
      status,
      // Same vocabulary as paymentEntries: a method CODE (gcash | maya | qrph | cash | bank_transfer) or "" when
      // there is none ("PayMongo", "—" ...). Never a display label, so the ledger filters and groups cleanly.
      paymentMethod: normalizeMethod(paymentMethod).method || "",
      // "" when there is no reference -- never the "—" / "N/A" placeholders.
      referenceNumber: nullIfSentinel(referenceNumber) || "",
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

// Marks every still-"Success" entry tied to a given maintenance record as
// "Rejected" instead of deleting or writing a negative-amount reversal —
// same status vocabulary refund requests already use for "this no longer
// counts". Used when the record that caused an Expense entry (e.g. a
// maintenance record) gets deleted, so it stops counting toward any
// Success-based total while the original entry stays in the ledger as
// history instead of disappearing.
export const rejectTransactionLogsByMaintenance = async (maintenanceID) => {
  try {
    const snap = await db.collection("transactionLogs")
      .where("maintenanceID", "==", maintenanceID)
      .where("status", "==", "Success")
      .get();
    if (snap.empty) return 0;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.update(doc.ref, { status: "Rejected" }));
    await batch.commit();
    return snap.size;
  } catch (err) {
    console.error("rejectTransactionLogsByMaintenance error:", err.message);
    return 0;
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