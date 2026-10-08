// paymentEntries -- bound to the real Firestore connection.
// READERS: anything that reads a payment / penalty document and uses a field the PHASE 2 cleanup removes
// (PayMongo payment ids, fees, channel, proofUrl, paidAt, confirmedBy ...) must load it through
// hydratePayments / hydratePaymentData / hydratePenalties. See scripts/migrate-payment-entries.js.
// STEP 1: the legacy payment fields stay the source of truth. After a payment is written,
// syncPaymentEntries() re-derives its deposit / balance rows from the document, so the
// entries can never disagree with it. It never throws (a failure must not block a payment).
//
// Rows live in their own collection keyed by paymentID / bookingID and are NOT archived with
// the booking (same convention as driverAssignments / cancellationRequests): a restore
// reconnects them automatically. Only the permanent delete in bookingArchives.service.js
// removes them (getEntryRefsForBooking).
import { db } from "../../config/firebaseConnection/firebase.js";
import { makeEntriesDb } from "./paymentEntries.core.js";
import { ENTRY_COLLECTION } from "../../models/paymentEntries/paymentEntry.model.js";

const svc = makeEntriesDb(db);

export const syncPaymentEntries       = svc.syncPaymentEntries;
export const syncRefundEntries        = svc.syncRefundEntries;
export const hydrateRefundRequests    = svc.hydrateRefundRequests;
export const writeRefundEntries       = svc.writeRefundEntries;
export const getEntriesForPaymentIDs  = svc.getEntriesForPaymentIDs;
export const getEntriesForPenaltyIDs  = svc.getEntriesForPenaltyIDs;
export const hydratePayments          = svc.hydratePayments;
export const hydratePaymentData       = svc.hydratePaymentData;
export const hydratePenalties         = svc.hydratePenalties;
export const getEntryRefsForBooking   = svc.getEntryRefsForBooking;
export { ENTRY_COLLECTION };