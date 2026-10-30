import { db } from "../../config/firebaseConnection/firebase.js";
import { findLinkedBookingSessionArchive } from "./bookingSessionArchives.service.js";
import { resolveUserNames } from "./resolveUserName.service.js";
import { getAssignmentRefsForBooking } from "../driverAssignments/driverAssignments.service.js";
import { getRequestRefsForBooking } from "../cancellationRequests/cancellationRequests.service.js";
import { getEntryRefsForBooking, hydratePaymentData } from "../paymentEntries/paymentEntries.service.js";
import { roleIDToName, CUSTOMER_ROLE_ID } from "../../utils/roles/role.util.js";
import { stripArchiveMeta } from "./archiveMeta.js";
import { restoreLinkedForBooking, getLinkedArchiveRefsForBooking } from "./linkedArchives.service.js";
import {
  restoreInspectionArchiveForBooking,
  getInspectionArchiveSnapsForBooking,
  getArchivedInspectionForBooking,
  inspectionFileUrls,
  removeInspectionFiles,
} from "./vehicleInspectionArchives.service.js";
import { restoreMaintenanceArchivesForBooking, getMaintenanceArchiveRefsForBooking } from "./maintenanceArchives.service.js";
import { restorePenaltyArchivesForBooking, getPenaltyArchiveRefsForBooking } from "./penaltyArchives.service.js";
import { restoreRefundArchivesForBooking, getRefundArchiveRefsForBooking } from "./refundArchives.service.js";

const toISO = (val) => (val?.toDate ? val.toDate().toISOString() : val ?? null);

// ── GET ALL ──────────────────────────────────────────────────────────────────
export const getAllBookingArchives = async () => {
  const snapshot = await db
    .collection("bookingArchives")
    .orderBy("archivedAt", "desc")
    .get();

  // Resolve customerName once for the whole page, same pattern as the
  // other archive list endpoints — bookingArchives stores userID directly
  // so no booking lookup is needed here (unlike paymentsArchives).
  const nameMap = await resolveUserNames(snapshot.docs.map((doc) => doc.data().userID));

  // For each booking archive, fetch the linked payment archive amount
  const results = await Promise.all(
    snapshot.docs.map(async (doc) => {
      const data = doc.data();
      const bookingID = data.bookingID ?? doc.id;

      // Look up the linked payment archive for the actual amount.
      // (bookingArchives no longer stores its own totalFee — the payment
      // archive's `amount` is the real source, looked up below.)
      let paymentAmount = null;
      try {
        const paySnap = await db
          .collection("paymentsArchives")
          .where("bookingID", "==", bookingID)
          .limit(1)
          .get();
        if (!paySnap.empty) {
          const payData = paySnap.docs[0].data();
          paymentAmount = payData.amount ?? payData.rentalFee ?? paymentAmount;
        }
      } catch (_) {}

      return {
        bookingArchivesId: doc.id,
        originalId: doc.id, // response only (the ID is no longer stored as a field)
        ...data,
        customerName: data.userID ? (nameMap[data.userID] || "—") : "—",
        amount: paymentAmount,
        startDateTime: toISO(data.startDateTime),
        endDateTime:   toISO(data.endDateTime),
        createdAt:     toISO(data.createdAt),
        archivedAt:    toISO(data.archivedAt),
      };
    })
  );

  return results;
};

// ── HELPERS: find linked archive docs by bookingID ────────────────────────────
const findLinkedPaymentArchive = async (bookingID) => {
  if (!bookingID) return null;
  const snap = await db
    .collection("paymentsArchives")
    .where("bookingID", "==", bookingID)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0];
};

const findLinkedReviewArchives = async (bookingID) => {
  if (!bookingID) return [];
  const snap = await db
    .collection("reviewsArchives")
    .where("bookingID", "==", bookingID)
    .get();
  return snap.docs;
};

// Vehicle Inspection records (damage/parts status + photo links) are archived with the booking into ONE
// vehicleInspectionArchives doc (services/archives/vehicleInspectionArchives.service.js). Bookings archived BEFORE
// that existed still have their records in these four live collections, so this list is kept for them: it feeds
// (a) the "View Vehicle Inspection" modal on the Booking Archive page (archive doc first, live as fallback) and
// (b) the permanent-delete cascade below, which cleans up either form.
const INSPECTION_COLLECTIONS = [
  "inventoryBeforeTrip",
  "inventoryAfterTrip",
  "vehicleDocumentationBeforeTrip",
  "vehicleDocumentationAfterTrip",
];

export const findLinkedInspectionDocs = async (bookingID) => {
  if (!bookingID) return [];
  const snaps = await Promise.all(
    INSPECTION_COLLECTIONS.map((name) =>
      db.collection(name).where("bookingID", "==", bookingID).get()
    )
  );
  return snaps.flatMap((snap) => snap.docs);
};

// Same data as findLinkedInspectionDocs, but shaped for direct display
// (grouped by collection, timestamps normalized) rather than for deletion.
export const getInspectionRecordsForBooking = async (bookingID) => {
  const archived = bookingID ? await getArchivedInspectionForBooking(bookingID) : null;
  if (archived) return archived;
  if (!bookingID) return { inventoryBeforeTrip: [], inventoryAfterTrip: [], vehicleDocumentationBeforeTrip: [], vehicleDocumentationAfterTrip: [] };
  const snaps = await Promise.all(
    INSPECTION_COLLECTIONS.map((name) =>
      db.collection(name).where("bookingID", "==", bookingID).get()
    )
  );
  const result = {};
  INSPECTION_COLLECTIONS.forEach((name, i) => {
    result[name] = snaps[i].docs.map((d) => ({
      id: d.id,
      ...d.data(),
      createdAt: toISO(d.data().createdAt),
    }));
  });
  return result;
};

// ── RESTORE (cascade) ─────────────────────────────────────────────────────────
// 1. Restore booking → bookings collection
// 2. Restore linked paymentsArchives entry → payments collection (if found)
// 3. Restore linked reviewsArchives entries → reviews collection (if any)
// 3b. Restore the booking's penaltyArchives / refundArchives, and its driverAssignmentArchives,
//     cancellationRequestArchives, paymentEntryArchives and maintenanceArchives, into their live collections
// 4. Delete all the archive records (booking, payment, reviews, session ...)
export const restoreBookingArchive = async (bookingArchivesId, restoredBy = "admin") => {
  const archiveRef = db.collection("bookingArchives").doc(bookingArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking not found.");

  const archived1 = archiveDoc.data();
  const originalId = archiveDoc.id; // the archive's ID is the live booking's ID
  const originalData = stripArchiveMeta(archived1);

  const bookingID = originalData.bookingID ?? originalId;

  // ── 1. Restore booking ──
  const bookingActiveRef = originalId
    ? db.collection("bookings").doc(originalId)
    : db.collection("bookings").doc();

  await bookingActiveRef.set(originalData);

  // ── 2. Find and restore linked payment archive ──
  const paymentArchiveDoc = await findLinkedPaymentArchive(bookingID);
  // ── 2b. Find linked bookingSessionArchive — restored via its own
  // recreation logic below (recreates archive/{date} day-docs too, which
  // this file has no reason to duplicate) ──
  const sessionArchiveDoc = await findLinkedBookingSessionArchive(bookingID);
  if (paymentArchiveDoc) {
    const archived2 = paymentArchiveDoc.data();
    const payOriginalId = paymentArchiveDoc.id;
    const payOriginalData = stripArchiveMeta(archived2);

    const paymentActiveRef = payOriginalId
      ? db.collection("payments").doc(payOriginalId)
      : db.collection("payments").doc();

    await paymentActiveRef.set(payOriginalData);
  }

  // ── 2c. Restore linked bookingSession ──
  // GPS pings live in Sheets now, not a subcollection under this doc — Sheets
  // rows were never touched by the archive/delete, so there's no day-doc
  // trail to recreate here anymore, just the session doc itself.
  if (sessionArchiveDoc) {
    // stripArchiveMeta, not a hand-written list: the archive stores bookingSessionArchivesID (capital D) and the old
    // list only knew the lowercase spelling, so that id was written onto the live session.
    const sessionOriginalId = sessionArchiveDoc.id;
    const sessionOriginalData = stripArchiveMeta(sessionArchiveDoc.data());

    const sessionActiveRef = sessionOriginalId
      ? db.collection("bookingSessions").doc(sessionOriginalId)
      : db.collection("bookingSessions").doc();

    await sessionActiveRef.set(sessionOriginalData);
  }

  // ── 3. Find and restore linked reviews archives ──
  const reviewArchiveDocs = await findLinkedReviewArchives(bookingID);
  for (const reviewDoc of reviewArchiveDocs) {
    const revOriginalId = reviewDoc.id;
    const reviewOriginalData = stripArchiveMeta(reviewDoc.data());

    const reviewActiveRef = revOriginalId
      ? db.collection("reviews").doc(revOriginalId)
      : db.collection("reviews").doc();

    await reviewActiveRef.set(reviewOriginalData);
  }

  // ── 3b. Restore the linked penalties, refund requests, driver assignments, cancellation requests and
  // payment entries. Each restore moves its rows back and deletes their archive copies in the same batch.
  // Rows are found under every key the booking is known by (bookingID field and Firestore doc id); entries
  // written without a bookingID are found through the payment id. ──
  const restoredPenalties = await restorePenaltyArchivesForBooking(bookingID);
  const restoredRefunds   = await restoreRefundArchivesForBooking(bookingID);
  const paymentArchiveData = paymentArchiveDoc ? paymentArchiveDoc.data() : null;
  const linkedRestored = await restoreLinkedForBooking({
    bookingKeys: [bookingID, originalId],
    paymentIDs: paymentArchiveData ? [paymentArchiveData.paymentID ?? paymentArchiveDoc.id] : [],
  });
  const restoredMaintenance = await restoreMaintenanceArchivesForBooking({ bookingKeys: [bookingID, originalId] });
  const restoredInspection = await restoreInspectionArchiveForBooking({ bookingKeys: [bookingID, originalId] });

  // ── 4. Delete all archive records (batch) ──
  const batch = db.batch();
  batch.delete(archiveRef); // booking archive

  if (paymentArchiveDoc) {
    batch.delete(paymentArchiveDoc.ref); // payment archive
  }
  for (const reviewDoc of reviewArchiveDocs) {
    batch.delete(reviewDoc.ref); // each review archive
  }
  if (sessionArchiveDoc) {
    batch.delete(sessionArchiveDoc.ref); // bookingSession archive
  }

  await batch.commit();

  return {
    restoredPayment: !!paymentArchiveDoc,
    restoredReviews: reviewArchiveDocs.length,
    restoredSession: !!sessionArchiveDoc,
    restoredPenalties,
    restoredRefunds,
    restoredDriverAssignments:    linkedRestored.driverAssignments,
    restoredCancellationRequests: linkedRestored.cancellationRequests,
    restoredPaymentEntries:       linkedRestored.paymentEntries,
    restoredMaintenance,
    restoredInspection,
  };
};

// ── PERMANENT DELETE (cascade) ────────────────────────────────────────────────
// Deletes the bookingArchive + its linked paymentsArchives + reviewsArchives
export const deleteBookingArchive = async (bookingArchivesId) => {
  const archiveRef = db.collection("bookingArchives").doc(bookingArchivesId);
  const archiveDoc = await archiveRef.get();
  if (!archiveDoc.exists) throw new Error("Archived booking not found.");

  const data = archiveDoc.data();
  const bookingID = data.bookingID ?? archiveDoc.id;

  // Find linked archives
  const paymentArchiveDoc  = await findLinkedPaymentArchive(bookingID);
  const reviewArchiveDocs  = await findLinkedReviewArchives(bookingID);
  const sessionArchiveDoc  = await findLinkedBookingSessionArchive(bookingID);
  // Live inspection docs: normally already moved into vehicleInspectionArchives
  // when the booking was deleted. Older bookings (archived before that existed)
  // may still have them in their live collections, so they are cleaned up here too.
  const inspectionDocs     = await findLinkedInspectionDocs(bookingID);
  // Live driverAssignments / cancellationRequests rows: only bookings archived before these had
  // their own archives still have them in the live tables (keyed by bookingID). Newer bookings
  // keep them in driverAssignmentArchives / cancellationRequestArchives (cleaned up below).
  const assignmentRefs     = await getAssignmentRefsForBooking(bookingID);
  const requestRefs        = await getRequestRefsForBooking(bookingID);
  // Live paymentEntries rows: same story, only older bookings still have them live
  // (keyed by bookingID / paymentID). Newer ones are in paymentEntryArchives.
  const entryRefs          = await getEntryRefsForBooking(bookingID);
  // Bookings archived since then keep those rows in driverAssignmentArchives / cancellationRequestArchives /
  // paymentEntryArchives (and the penalty and refund archives); the live-row cleanup above covers older bookings.
  const paymentID          = paymentArchiveDoc ? (paymentArchiveDoc.data().paymentID ?? paymentArchiveDoc.id) : null;
  const linkedArchiveRefs  = await getLinkedArchiveRefsForBooking({
    bookingKeys: [bookingID, archiveDoc.id],
    paymentIDs: paymentID ? [paymentID] : [],
  });
  const penaltyArchiveRefs = await getPenaltyArchiveRefsForBooking(bookingID);
  const refundArchiveRefs  = await getRefundArchiveRefsForBooking(bookingID);
  const maintenanceArchiveRefs = await getMaintenanceArchiveRefsForBooking({ bookingKeys: [bookingID, archiveDoc.id] });
  // vehicle inspection archive (new) + the Storage files (photos, GPS history JSON) behind every record that goes
  const inspectionArchiveSnaps = await getInspectionArchiveSnapsForBooking({ bookingKeys: [bookingID, archiveDoc.id] });
  const fileUrls = inspectionFileUrls({ archiveSnaps: inspectionArchiveSnaps, liveDocs: inspectionDocs });
  if (sessionArchiveDoc?.data().archiveUrl) fileUrls.add(sessionArchiveDoc.data().archiveUrl);

  // Delete everything that hangs off the booking archive first, in chunks of 450 (a Firestore batch takes at most 500
  // writes), and the booking archive itself LAST: if a chunk fails the booking archive is still there, so the same
  // permanent delete can simply be run again.
  const refs = [];
  if (paymentArchiveDoc) refs.push(paymentArchiveDoc.ref);
  for (const reviewDoc of reviewArchiveDocs) refs.push(reviewDoc.ref);
  if (sessionArchiveDoc) refs.push(sessionArchiveDoc.ref);
  for (const inspectionDoc of inspectionDocs) refs.push(inspectionDoc.ref);
  refs.push(...inspectionArchiveSnaps.map((s) => s.ref), ...assignmentRefs, ...requestRefs, ...entryRefs, ...linkedArchiveRefs, ...penaltyArchiveRefs, ...refundArchiveRefs, ...maintenanceArchiveRefs);

  const uniqueRefs = [...new Map(refs.map((r) => [r.path, r])).values()];
  for (let i = 0; i < uniqueRefs.length; i += 450) {
    const batch = db.batch();
    uniqueRefs.slice(i, i + 450).forEach((r) => batch.delete(r));
    await batch.commit();
  }
  await archiveRef.delete();

  // Last of all: the files. Only now is nothing left that could be restored and would still need them.
  const files = await removeInspectionFiles(fileUrls);

  return {
    deletedPaymentArchive: !!paymentArchiveDoc,
    deletedReviewArchives: reviewArchiveDocs.length,
    deletedSessionArchive: !!sessionArchiveDoc,
    deletedInspectionDocs: inspectionDocs.length,
    deletedAssignments:    assignmentRefs.length,
    deletedCancellationRequests: requestRefs.length,
    deletedPaymentEntries: entryRefs.length,
    deletedLinkedArchives: linkedArchiveRefs.length,
    deletedPenaltyArchives: penaltyArchiveRefs.length,
    deletedRefundArchives: refundArchiveRefs.length,
    deletedMaintenanceArchives: maintenanceArchiveRefs.length,
    deletedInspectionArchives: inspectionArchiveSnaps.length,
    deletedFiles: files.deleted,
    failedFiles: files.failed,
  };
};

// ══════════════════════════════════════════════════════════════════════════════
// DETAILS (what the live Bookings window shows, for the Booking tab of the Booking Archive page)
// ══════════════════════════════════════════════════════════════════════════════
// The bookingArchives document is only a COPY of the booking (ids, dates, status, ...). The live Bookings window shows
// much more: vehicle, service type, driver, customer contact, the fee breakdown, who cancelled it and why, the refund,
// the Terms version and the pickup / drop-off places. Those live in other collections that are archived together with
// the booking (paymentsArchives, driverAssignmentArchives, cancellationRequestArchives, refundArchives,
// bookingSessionArchives) or are still live (cars, model, brand, serviceType, termsVersions, user, userDetails).
// getBookingArchiveDetails() reads them all for ONE archived booking. Read-only: nothing here writes.

// Timestamps (also nested ones) -> ISO strings, so the page can show them.
const plain = (v) => {
  if (v?.toDate) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};
const ms = (v) => {
  const t = v?.toMillis ? v.toMillis() : v?._seconds !== undefined ? v._seconds * 1000 : v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
};

// One person: { id, name, username, email, phone, role, state } where state is
// "active" (live account) | "archived" (sitting in userArchives) | "removed" (gone).
// Names come from userDetails, which stays live even while the account is archived.
const lookupPerson = async (id) => {
  if (!id) return null;
  try {
    let state = "active";
    let userDoc = await db.collection("user").doc(id).get();
    if (!userDoc.exists) {
      userDoc = await db.collection("userArchives").doc(id).get();
      state = userDoc.exists ? "archived" : "removed";
    }
    const u = userDoc.exists ? userDoc.data() : {};

    let fullName = "";
    const d = await db.collection("userDetails").where("userID", "==", id).limit(1).get();
    if (!d.empty) fullName = [d.docs[0].data().firstName, d.docs[0].data().lastName].filter(Boolean).join(" ").trim();

    let role = null;
    if (u.roleID) {
      role = roleIDToName(u.roleID) ?? (u.roleID === CUSTOMER_ROLE_ID ? "Customer" : null);
      if (!role) {
        const r = await db.collection("roles").doc(u.roleID).get();
        role = r.exists ? r.data().roleName || null : null;
      }
    }
    return {
      id,
      name: fullName || u.username || u.email || null,
      username: u.username || null,
      email: u.email || null,
      phone: u.phone || null,
      role,
      state,
    };
  } catch {
    return { id, name: null, username: null, email: null, phone: null, role: null, state: "removed" };
  }
};

// "Toyota Vios" + plate number. The car may have been deleted since, which just leaves the name empty.
const lookupVehicle = async (carID) => {
  if (!carID) return { name: null, plateNumber: null };
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return { name: null, plateNumber: null };
    const { modelID, plateNumber = null } = carDoc.data();
    let name = null;
    if (modelID) {
      const modelDoc = await db.collection("model").doc(modelID).get();
      if (modelDoc.exists) {
        const { brandID, modelName } = modelDoc.data();
        const brandDoc = brandID ? await db.collection("brand").doc(brandID).get() : null;
        name = [brandDoc?.exists ? brandDoc.data().brandName : "", modelName].filter(Boolean).join(" ") || null;
      }
    }
    return { name, plateNumber };
  } catch {
    return { name: null, plateNumber: null };
  }
};

const lookupServiceType = async (serviceTypeID) => {
  if (!serviceTypeID) return null;
  try {
    const doc = await db.collection("serviceType").doc(serviceTypeID).get();
    return doc.exists ? doc.data().serviceType || null : null;
  } catch {
    return null;
  }
};

const lookupTermsVersion = async (termsVersionID) => {
  if (!termsVersionID) return null;
  try {
    const doc = await db.collection("termsVersions").doc(String(termsVersionID)).get();
    return doc.exists ? doc.data().version ?? null : null;
  } catch {
    return null;
  }
};

// Same wording rules as describeCancellation() in services/booking/booking.service.js (the live Bookings page):
// who cancelled, why (system-written wording is not a reason) and when.
const SYSTEM_REASON = /^(Cancelled: refund (approved|completed)\.?|Cancelled by user\.?|Cancelled by (admin|staff)\.?)$/i;
const describeCancellation = (all) => {
  const approvedReq = all.find((r) => !r.cancelledBy && !r.refundRequestID && r.status === "approved");
  const refundRow = all.find((r) => r.refundRequestID && r.reason);
  const direct = all.find((r) => r.cancelledBy) || null;
  const reasonRow = direct || all.find((r) => r.status === "approved" && r.reason);

  let cancelledBy = null;
  if (direct) {
    cancelledBy = ["customer", "refund"].includes(direct.cancelledBy) ? "customer"
      : ["staff", "admin"].includes(direct.cancelledBy) ? "staff"
      : direct.cancelledBy === "system" ? "system" : "unknown";
  } else if (approvedReq) {
    cancelledBy = "customer"; // the customer asked to end an ongoing trip and staff approved it
  }

  let reason = String(reasonRow?.reason || "").trim().replace(/^Cancelled by (staff|admin):\s*/i, "").trim();
  if (SYSTEM_REASON.test(reason)) reason = "";
  if (!reason && direct?.cancelledBy === "refund" && refundRow) reason = String(refundRow.reason).trim();

  const cancelledByID = cancelledBy === "customer" ? (direct?.userID || approvedReq?.userID || null)
    : cancelledBy === "staff" ? (direct?.processedBy || null)
    : null;
  const approvedByID = cancelledBy === "customer" ? (direct?.processedBy || approvedReq?.processedBy || null) : null;
  return {
    cancelledBy,
    cancelledByID,
    approvedByID,
    reason,
    cancelledAt: direct ? (direct.createdAt || null) : (approvedReq?.processedAt || approvedReq?.updatedAt || null),
  };
};

// The booking's latest refund request boiled down to Pending | Refunded | Failed | No refund (same as the live page).
const describeRefund = (rows) => {
  const r = [...rows].sort((x, y) => ms(y.createdAt) - ms(x.createdAt))[0];
  if (!r) return null;
  const st = String(r.status || "").toLowerCase();
  const outcome = r.outcome || null;
  const status = st === "refunded" ? (outcome === "nothing_owed" || outcome === "already_refunded" ? "No refund" : "Refunded")
    : st === "failed" ? "Failed"
    : st === "rejected" ? "No refund"
    : "Pending";
  return {
    status,
    refundRequestID: r.refundRequestID || null,
    amount: Number(r.toRefundAmount ?? r.amount ?? 0) || 0,
    bookingPaid: Number(r.bookingPaid ?? r.grossPaid ?? 0) || 0,
    byStaff: r.source === "staff",
    gatewayFeeKept: Number(r.gatewayFeeKept) || 0,
    depositForfeited: Number(r.depositForfeited) || 0,
  };
};

export const getBookingArchiveDetails = async (bookingArchivesId) => {
  const doc = await db.collection("bookingArchives").doc(bookingArchivesId).get();
  if (!doc.exists) throw new Error("Archived booking not found.");
  const b = doc.data();
  // linked archive rows carry the booking's own bookingID or its Firestore doc id
  const keys = [...new Set([b.bookingID, doc.id].filter(Boolean))];

  const [vehicle, serviceTypeName, termsVersionNumber, customer, driverSnap, cancelSnap, cancelByDoc, paySnap, refundSnap, sessionDoc] =
    await Promise.all([
      lookupVehicle(b.carID),
      lookupServiceType(b.serviceTypeID),
      lookupTermsVersion(b.termsVersionID),
      lookupPerson(b.userID),
      db.collection("driverAssignmentArchives").where("bookingID", "in", keys).get(),
      db.collection("cancellationRequestArchives").where("bookingID", "in", keys).get(),
      // a direct cancellation row is keyed by its booking (very old ones carry no bookingID at all)
      Promise.all(keys.map((k) => db.collection("cancellationRequestArchives").doc(k).get())),
      db.collection("paymentsArchives").where("bookingID", "in", keys).limit(1).get(),
      db.collection("refundArchives").where("bookingID", "in", keys).get(),
      findLinkedBookingSessionArchive(b.bookingID ?? doc.id),
    ]);

  // ── driver: the one still assigned, else the last one who finished the trip (an "unassigned" row is not a driver) ──
  const assignments = driverSnap.docs.map((d) => d.data()).filter((a) => a.status !== "unassigned");
  const assignment = assignments.find((a) => a.status === "assigned")
    || assignments.sort((x, y) => ms(y.assignedAt) - ms(x.assignedAt))[0]
    || null;
  const driverPerson = assignment ? await lookupPerson(assignment.driverID) : null;
  const driver = assignment ? { ...driverPerson, assignmentStatus: assignment.status, assignedAt: plain(assignment.assignedAt) } : null;

  // ── payment: fee breakdown + deposit ──
  let payment = null;
  if (!paySnap.empty) {
    const p = await hydratePaymentData(paySnap.docs[0].data(), paySnap.docs[0].id);
    payment = plain({
      amount: p.amount ?? 0,
      rentalFee: p.rentalFee ?? 0,
      serviceFee: p.serviceFee ?? 0,
      extraFee: p.extraFee ?? 0,
      driversFee: p.driversFee ?? 0,
      gatewayFee: p.gatewayFee ?? 0,
      securityDeposit: Number(p.securityDeposit) || 0,
      depositStatus: p.depositStatus || null,
      discountAmount: Number(p.discountAmount) || 0,
      paymentMethod: p.paymentMethod || null,
      methodOfPayment: p.methodOfPayment || null,
      status: p.status || null,
      refundDue: Number(p.refundDue) || 0,
      refundIssued: !!p.refundIssued,
    });
  }

  // ── cancellation: who, why, when (+ refund) ──
  const cancelRows = new Map();
  cancelSnap.docs.forEach((d) => cancelRows.set(d.id, d.data()));
  cancelByDoc.filter((d) => d.exists).forEach((d) => cancelRows.set(d.id, d.data()));
  const allCancel = [...cancelRows.values()].sort((x, y) => ms(y.createdAt ?? y.requestedAt) - ms(x.createdAt ?? x.requestedAt));
  let cancellation = null;
  if (allCancel.length || String(b.status || "").toLowerCase() === "cancelled") {
    const info = describeCancellation(allCancel);
    const [byPerson, approver] = await Promise.all([lookupPerson(info.cancelledByID), lookupPerson(info.approvedByID)]);
    cancellation = plain({
      cancelledBy: info.cancelledBy,
      cancelledByName: byPerson?.name || null,
      cancelledByRole: info.cancelledBy === "staff" ? byPerson?.role || null : null,
      approvedByName: approver?.name || null,
      approvedByRole: approver?.role || null,
      cancelledAt: info.cancelledAt,
      reason: info.reason,
    });
  }
  const refund = describeRefund(refundSnap.docs.map((d) => d.data()));

  // ── session: where the car was picked up / dropped off, plus any extra stops ──
  const session = sessionDoc ? sessionDoc.data() : null;

  return {
    customer,
    vehicle,
    serviceTypeName,
    driver,
    payment,
    cancellation,
    refund,
    terms: { versionID: b.termsVersionID || null, versionNumber: termsVersionNumber, acceptedAt: plain(b.termsAcceptedAt) ?? null },
    places: session
      ? plain({
          pickupLocation: session.pickupLocation ?? null,
          dropoffLocation: session.dropoffLocation ?? null,
          geofenceZones: Array.isArray(session.geofenceZones) ? session.geofenceZones : [],
          currentPosition: session.currentPosition ?? null,
        })
      : { pickupLocation: null, dropoffLocation: null, geofenceZones: [], currentPosition: null },
  };
};