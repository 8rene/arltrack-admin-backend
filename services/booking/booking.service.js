import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { getSessionByBookingID, markSessionActive, markSessionEnded, markSessionCancelled, markSessionStolen } from "../../services/booking/bookingSession.service.js";
import { flushBookingHistory } from "../../services/storage/bookingHistory.service.js";
// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const resolveVehicleName = async (carID) => {
  if (!carID) return "—";
  try {
    const carDoc = await db.collection("cars").doc(carID).get();
    if (!carDoc.exists) return "—";
    const { modelID } = carDoc.data();
    if (!modelID) return "—";
    const modelDoc = await db.collection("model").doc(modelID).get();
    if (!modelDoc.exists) return "—";
    const { brandID, modelName } = modelDoc.data();
    const brandDoc = await db.collection("brand").doc(brandID).get();
    const brandName = brandDoc.exists ? brandDoc.data().brandName : "";
    return [brandName, modelName].filter(Boolean).join(" ") || "—";
  } catch { return "—"; }
};

// bookingID → { paymentMethod, totalFee } from payments collection
// totalFee comes from payments.amount field
const resolvePaymentInfo = async (bookingID) => {
  if (!bookingID) return { paymentMethod: "—", totalFee: 0 };
  try {
    const snap = await db.collection("payments")
      .where("bookingID", "==", bookingID)
      .limit(1)
      .get();
    if (snap.empty) return { paymentMethod: "—", totalFee: 0 };
    const data = snap.docs[0].data();
    return {
      paymentMethod: data.paymentMethod || "—",
      totalFee: data.amount ?? 0,
    };
  } catch { return { paymentMethod: "—", totalFee: 0 }; }
};

const resolveUserInfo = async (userID) => {
  if (!userID) return { customerName: "—", phone: "—" };
  try {
    const [detailDoc, userDoc] = await Promise.all([
      db.collection("userDetails").doc(userID).get(),
      db.collection("user").doc(userID).get(),
    ]);
    const { firstName = "", lastName = "" } = detailDoc.exists ? detailDoc.data() : {};
    const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
    const { phone = "—", username = "", email = "" } = userDoc.exists ? userDoc.data() : {};
    const customerName = fullName || username || email || "—";
    return { customerName, phone };
  } catch { return { customerName: "—", phone: "—" }; }
};

const resolveServiceType = async (serviceTypeID) => {
  if (!serviceTypeID) return "—";
  try {
    const doc = await db.collection("serviceType").doc(serviceTypeID).get();
    if (!doc.exists) return "—";
    return doc.data().serviceTypeName || doc.data().name || "—";
  } catch { return "—"; }
};

// bookingID → { hasHistory, bookingSessionID, lastArchivedAt } — powers the
// "Trip History" row in the Bookings page's detail view, and the deep-link
// into Car Tracking's History tab (see routes/booking/booking.routes.js
// callers). hasHistory is true only once bookingHistory.service.js has
// actually flushed a trail to Storage (archiveUrl set) — a session that
// exists but never got flushed still reports false, same as "no session at
// all", since either way there's nothing in History to show yet.
const resolveHistoryInfo = async (bookingID) => {
  if (!bookingID) return { hasHistory: false, bookingSessionID: null, lastArchivedAt: null };
  try {
    const snap = await db.collection("bookingSessions").where("bookingID", "==", bookingID).limit(1).get();
    if (snap.empty) return { hasHistory: false, bookingSessionID: null, lastArchivedAt: null };
    const data = snap.docs[0].data();
    return {
      hasHistory:       !!data.archiveUrl,
      bookingSessionID: data.bookingSessionID || null,
      lastArchivedAt:   data.lastArchivedAt || null,
    };
  } catch { return { hasHistory: false, bookingSessionID: null, lastArchivedAt: null }; }
};

// ─────────────────────────────────────────────
// Archive to notificationsArchive when booking status resolves
// (Frontend reads live from bookings collection directly)
// ─────────────────────────────────────────────
const archiveNotification = async ({ userID, bookingID, docID, oldStatus, newStatus, bookingData }) => {
  try {
    await db.collection("notificationsArchive").add({
      bookingDocID:   docID,
      bookingID:      bookingID || docID,
      userID:         userID || "",
      previousStatus: oldStatus || "",
      resolvedStatus: newStatus || "",
      startDateTime:  bookingData.startDateTime  || null,
      endDateTime:    bookingData.endDateTime    || null,
      carID:          bookingData.carID          || "",
      location:       bookingData.location       || "",
      notesAdmin:     bookingData.notesAdmin     || "",
      archivedAt:     admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("[ARCHIVE] Notification archived for booking:", bookingID);
  } catch (err) {
    console.error("[ARCHIVE] Failed:", err.message);
  }
};



// ─────────────────────────────────────────────
// Main service functions
// ─────────────────────────────────────────────

export const getAllBookings = async (statusFilter) => {
  const filter = statusFilter?.toLowerCase();

  let rows = [];
  if (!filter || filter === "all") {
    const statuses = ["upcoming", "ongoing", "completed", "cancelled", "cancellation_request", "stolen"];
    const snaps = await Promise.all(
      statuses.map((s) => db.collection("bookings").where("status", "==", s).get())
    );
    snaps.forEach((s) => s.forEach((doc) => rows.push({ id: doc.id, ...doc.data() })));
  } else {
    const s = await db.collection("bookings").where("status", "==", filter).get();
    s.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
  }

  rows.sort((a, b) => {
    const ta = a.updatedAt?.toMillis?.() ?? 0;
    const tb = b.updatedAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  const carIDs         = [...new Set(rows.map((b) => b.carID).filter(Boolean))];
  const bookingIDs     = [...new Set(rows.map((b) => b.bookingID || b.id).filter(Boolean))];
  const userIDs        = [...new Set(rows.map((b) => b.userID).filter(Boolean))];
  const serviceTypeIDs = [...new Set(rows.map((b) => b.serviceTypeID).filter(Boolean))];

  const [vehicleEntries, paymentEntries, userEntries, serviceTypeEntries, historyEntries] = await Promise.all([
    Promise.all(carIDs.map((id) => resolveVehicleName(id).then((v) => [id, v]))),
    Promise.all(bookingIDs.map((id) => resolvePaymentInfo(id).then((p) => [id, p]))),
    Promise.all(userIDs.map((id) => resolveUserInfo(id).then((u) => [id, u]))),
    Promise.all(serviceTypeIDs.map((id) => resolveServiceType(id).then((s) => [id, s]))),
    Promise.all(bookingIDs.map((id) => resolveHistoryInfo(id).then((h) => [id, h]))),
  ]);

  const vehicleMap     = Object.fromEntries(vehicleEntries);
  const paymentMap     = Object.fromEntries(paymentEntries);
  const userMap        = Object.fromEntries(userEntries);
  const serviceTypeMap = Object.fromEntries(serviceTypeEntries);
  const historyMap     = Object.fromEntries(historyEntries);

  return rows.map((b) => {
    const bID     = b.bookingID || b.id;
    const payInfo = paymentMap[bID] || { paymentMethod: "—", totalFee: 0 };
    const histInfo = historyMap[bID] || { hasHistory: false, bookingSessionID: null, lastArchivedAt: null };
    return {
      ...b,
      vehicleName:      vehicleMap[b.carID] || "—",
      paymentMethod:    payInfo.paymentMethod,
      totalFee:         payInfo.totalFee,        // from payments.amount
      customerName:     userMap[b.userID]?.customerName || "—",
      phone:            userMap[b.userID]?.phone || "—",
      serviceTypeName:  serviceTypeMap[b.serviceTypeID] || "—",
      hasHistory:       histInfo.hasHistory,
      bookingSessionID: histInfo.bookingSessionID,
      lastArchivedAt:   histInfo.lastArchivedAt,
    };
  });
};

export const updateBooking = async (docID, updates) => {
  const doc = await db.collection("bookings").doc(docID).get();
  if (!doc.exists) throw new Error("Booking not found");

  const bookingData = doc.data();
  const { status: oldStatus, userID, carID, bookingID } = bookingData;

  const nonEditable = ["completed", "cancelled", "stolen"]; // once flagged stolen, no further edits through this endpoint
  if (nonEditable.includes(oldStatus?.toLowerCase())) {
    throw new Error(`Cannot edit a booking with status: ${oldStatus}`);
  }

  const allowed = ["location", "startDateTime", "endDateTime", "notesAdmin", "notesUser", "status"];
  const filtered = {};
  allowed.forEach((k) => {
    if (updates[k] !== undefined) {
      filtered[k] = k === "status" ? updates[k].toLowerCase() : updates[k];
    }
  });

  // ── Payment validation: cannot mark picked-up/ongoing if payment is not yet approved/paid ──
  if (filtered.status === "ongoing" && oldStatus?.toLowerCase() !== "ongoing") {
    const bID = bookingID || docID;
    const paySnap = await db.collection("payments")
      .where("bookingID", "==", bID)
      .limit(1)
      .get();

    if (paySnap.empty) {
      throw new Error("Cannot approve booking: no payment record found for this booking.");
    }

    const paymentData = paySnap.docs[0].data();
    const payStatus   = paymentData.status || "";
    const approvedStatuses = ["approved", "paid"];

    if (!approvedStatuses.includes(payStatus.toLowerCase())) {
      throw new Error(
        `Cannot approve booking: payment is still "${payStatus}". ` +
        `Please approve the payment first in the Payments page.`
      );
    }
  }

  filtered.updatedAt = admin.firestore.FieldValue.serverTimestamp();

  await db.collection("bookings").doc(docID).update(filtered);

  // ── Link booking status transitions to the GPS session lifecycle ──
  // "ongoing" = pickup happened, car is now actually on the trip. This is
  // the one place that status-vocabulary decision actually takes effect —
  // flagging it here rather than silently assuming it, since it was still
  // an open question. Session activation/ending is best-effort: a failure
  // here must never block the booking status update itself, since staff
  // still need to be able to mark a car picked up/returned even if the
  // Firestore session link is temporarily unavailable.
  if (filtered.status === "ongoing" && oldStatus?.toLowerCase() !== "ongoing") {
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionActive(session.data.bookingSessionID, carID);
        // Flush right away too — mostly just so a file actually shows up in
        // Storage the moment tracking starts, as reassurance the pipeline is
        // wired correctly, rather than only ever appearing at Return or
        // whenever tonight's cron happens to run. It'll be near-empty at
        // this exact instant (no GPS pings have landed yet), and gets
        // overwritten with the real trail as the trip progresses and again
        // at Return — this first flush is just an early proof-of-life, not
        // the final archive.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Pickup flush failed (session still marked active, cron will retry tonight):", flushErr.message);
        }
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — GPS tracking won't start for this trip.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to activate GPS session:", err.message);
    }
  } else if (filtered.status === "completed" && oldStatus?.toLowerCase() === "ongoing") {
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionEnded(session.data.bookingSessionID);
        // Flush the full trail to Storage right now — this is the "Return"
        // action, no reason to make the history file wait for tonight's
        // cron when the trip is already over.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Return flush failed (session still marked ended, cron will retry tonight):", flushErr.message);
        }
      }
    } catch (err) {
      console.error("[Booking] Failed to end GPS session:", err.message);
    }
  } else if (filtered.status === "cancelled" && oldStatus?.toLowerCase() !== "cancelled") {
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionCancelled(session.data.bookingSessionID);
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — nothing to cancel.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to cancel GPS session:", err.message);
    }
  } else if (filtered.status === "stolen" && oldStatus?.toLowerCase() !== "stolen") {
    // Manual only — set by staff hitting "Stolen" on the car card. No
    // auto-trigger off geofence breach.
    try {
      const bID = bookingID || docID;
      const session = await getSessionByBookingID(bID);
      if (session) {
        await markSessionStolen(session.data.bookingSessionID);
        // Same as Return — flush the trail immediately for documentation
        // rather than waiting for the nightly cron. This is manual/admin-
        // triggered, so there's no reason to delay the record.
        try {
          await flushBookingHistory(session.data.bookingSessionID);
        } catch (flushErr) {
          console.error("[Booking] Stolen flush failed (session still marked stolen, cron will retry tonight):", flushErr.message);
        }
      } else {
        console.warn(`[Booking] No bookingSession found for booking ${bID} — cannot flag session stolen.`);
      }
    } catch (err) {
      console.error("[Booking] Failed to flag session stolen:", err.message);
    }
  }

  // ── Archive + auto-delete notification when booking moves out of pending/cancellation_request ──
  const newStatus = filtered.status;
  const activeStatuses = ["upcoming", "cancellation_request"];
  const resolvedStatuses = ["upcoming", "ongoing", "completed", "cancelled", "stolen"];
  if (
    newStatus &&
    newStatus !== oldStatus?.toLowerCase() &&
    activeStatuses.includes(oldStatus?.toLowerCase()) &&
    resolvedStatuses.includes(newStatus)
  ) {
    await archiveNotification({
      userID,
      bookingID: bookingID || docID,
      docID,
      oldStatus: oldStatus?.toLowerCase(),
      newStatus,
      bookingData,
    });

    // Delete corresponding notifications from the notifications collection
    try {
      const bID = bookingID || docID;
      const notifSnap = await db.collection("notifications")
        .where("bookingID", "==", bID)
        .where("type", "==", "new_booking")
        .get();
      if (!notifSnap.empty) {
        const batch = db.batch();
        notifSnap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        console.log(`[NOTIF] Auto-deleted ${notifSnap.size} new_booking notif(s) for booking: ${bID}`);
      }
    } catch (err) {
      console.error("[NOTIF] Failed to delete booking notifications:", err.message);
    }
  }

  return { success: true };
};