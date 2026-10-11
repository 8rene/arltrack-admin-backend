// driverAssignmentArchives / cancellationRequestArchives / paymentEntryArchives -- bound to the real Firestore
// connection. See linkedArchives.core.js for what each function does and why.
import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";
import { makeLinkedArchives, LINKED, LINKED_KINDS, chunk } from "./linkedArchives.core.js";

const svc = makeLinkedArchives(db, { now: () => admin.firestore.FieldValue.serverTimestamp() });

export { LINKED, LINKED_KINDS, chunk };
export const collectLinkedForBooking       = svc.collectLinkedForBooking;
export const writeLinkedArchives           = svc.writeLinkedArchives;
export const linkedLiveRefs                = svc.linkedLiveRefs;
export const restoreLinkedArchives         = svc.restoreLinkedArchives;
export const restoreLinkedForBooking       = svc.restoreLinkedForBooking;
export const restoreEntryArchivesBy        = svc.restoreEntryArchivesBy;
export const getLinkedArchiveRefsForBooking = svc.getLinkedArchiveRefsForBooking;
export const listLinkedArchives            = svc.listLinkedArchives;
export const deleteLinkedArchive           = svc.deleteLinkedArchive;
