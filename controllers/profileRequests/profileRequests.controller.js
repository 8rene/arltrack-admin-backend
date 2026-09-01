import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { resolveNotification } from "../notification/notification.service.js";

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const notFound = (message) => {
  const err = new Error(message);
  err.statusCode = 404;
  throw err;
};

// Guards approveProfileRequest/approveIdResubmitRequest against a request
// that's gone stale because the user's account was deleted after they
// submitted it (see deleteUser() in controllers/user/user.controller.js).
// Without this, applyProfileChanges()/upsertUserDocument()'s find-or-create
// logic would silently recreate a fresh userDetails/userAddress/userDocument
// doc for an account that no longer exists.
const requireLiveUser = async (userID) => {
  const userSnap = await db.collection("user").doc(userID).get();
  if (!userSnap.exists) {
    const err = new Error("This user's account has been deleted — the request can no longer be approved.");
    err.statusCode = 409;
    throw err;
  }
};

// ─────────────────────────────────────────────
// userDocument — one doc per userID. Used directly by ExpiryField
// (driverLicenseExpiry) and by the ID-resubmit approval flow below
// (driverLicenseUrl).
// ─────────────────────────────────────────────
export const upsertUserDocument = async (userID, fields) => {
  const existing = await db.collection("userDocument").where("userID", "==", userID).limit(1).get();

  if (!existing.empty) {
    await existing.docs[0].ref.update({ ...fields, updatedAt: timestamp() });
    return { id: existing.docs[0].id, userID, ...fields };
  }

  const ref = await db.collection("userDocument").add({
    userID,
    ...fields,
    createdAt: timestamp(),
  });
  return { id: ref.id, userID, ...fields };
};

// ─────────────────────────────────────────────
// Applies each changed field to the collection it actually lives in
// (user / userDetails / userAddress) — mirrors Profile.jsx's own
// "canEditDirectly" branch and Users.jsx's old client-side
// applyProfileChanges(), just running server-side now. Exported so both
// the admin-review approve path (below) and the self-service
// canEditDirectly path (Profile.jsx/Account.jsx, via the controller) can
// call the same logic.
// ─────────────────────────────────────────────
export const applyProfileChanges = async (userID, changes = []) => {
  const byCollection = { user: {}, userDetails: {}, userAddress: {} };
  changes.forEach((c) => {
    if (byCollection[c.collection]) byCollection[c.collection][c.field] = c.newValue;
  });

  if (Object.keys(byCollection.user).length) {
    await db.collection("user").doc(userID).update({ ...byCollection.user, updatedAt: timestamp() });
  }

  for (const col of ["userDetails", "userAddress"]) {
    if (!Object.keys(byCollection[col]).length) continue;
    const existing = await db.collection(col).where("userID", "==", userID).limit(1).get();
    if (!existing.empty) {
      await existing.docs[0].ref.update({ ...byCollection[col], updatedAt: timestamp() });
    } else {
      await db.collection(col).add({ userID, ...byCollection[col], createdAt: timestamp() });
    }
  }
};

// ─────────────────────────────────────────────
// editRequests — profile field-change requests (Profile.jsx / Account.jsx's
// EditProfileModal creates these; this approves one).
// ─────────────────────────────────────────────
export const approveProfileRequest = async (reqID) => {
  const ref = db.collection("editRequests").doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("Edit request not found.");
  const req = snap.data();

  await requireLiveUser(req.userID);
  await applyProfileChanges(req.userID, req.changes || []);
  await ref.update({ status: "approved", reviewedAt: timestamp(), updatedAt: timestamp() });

  resolveNotification("edit_request", reqID)
    .catch((err) => console.error("[NOTIF] Failed to resolve edit_request:", err.message));

  return { id: reqID, userID: req.userID };
};

// ─────────────────────────────────────────────
// idResubmitRequests — new driver's-license-photo submissions. Approving
// makes the new photo the license of record; deliberately does NOT touch
// driverLicenseExpiry (admin re-confirms that separately via ExpiryField,
// same "human looks at the actual card" principle as the original review).
// ─────────────────────────────────────────────
export const approveIdResubmitRequest = async (reqID) => {
  const ref = db.collection("idResubmitRequests").doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("ID resubmit request not found.");
  const req = snap.data();

  await requireLiveUser(req.userID);
  await upsertUserDocument(req.userID, { driverLicenseUrl: req.newLicenseUrl });
  await ref.update({ status: "approved", reviewedAt: timestamp(), updatedAt: timestamp() });

  return { id: reqID, userID: req.userID };
};

// ─────────────────────────────────────────────
// Shared reject path for both request kinds.
// ─────────────────────────────────────────────
export const rejectRequest = async (kind, reqID, note) => {
  const col = kind === "profile" ? "editRequests" : "idResubmitRequests";
  const ref = db.collection(col).doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("Request not found.");
  const req = snap.data();

  await ref.update({
    status: "rejected",
    reviewNote: note || null,
    reviewedAt: timestamp(),
    updatedAt: timestamp(),
  });

  if (kind === "profile") {
    resolveNotification("edit_request", reqID)
      .catch((err) => console.error("[NOTIF] Failed to resolve edit_request:", err.message));
  }

  return { id: reqID, userID: req.userID };
};

// ─────────────────────────────────────────────
// Self-service: a user submitting a request about their OWN profile.
// userID always comes from the verified token (req.user.uid) in the
// controller, never from the request body — otherwise anyone could
// submit an edit request that claims to be from a different user.
// ─────────────────────────────────────────────
export const createEditRequest = async (userID, role, changes) => {
  if (!Array.isArray(changes) || changes.length === 0) {
    const err = new Error("changes must be a non-empty array.");
    err.statusCode = 400;
    throw err;
  }

  const ref = await db.collection("editRequests").add({
    userID,
    role,
    status: "pending",
    changes,
    requestedBy: userID,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  return { id: ref.id, userID };
};

// Only the person who submitted the request can cancel it, and only
// while it's still pending — mirrors the old client-side behavior, just
// enforced server-side now instead of just being a UI convention.
export const cancelEditRequest = async (reqID, requesterUID) => {
  const ref = db.collection("editRequests").doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("Edit request not found.");
  const req = snap.data();

  if (req.requestedBy !== requesterUID) {
    const err = new Error("You can only cancel your own request.");
    err.statusCode = 403;
    throw err;
  }
  if (req.status !== "pending") {
    const err = new Error("Only a pending request can be cancelled.");
    err.statusCode = 400;
    throw err;
  }

  await ref.update({ status: "cancelled", updatedAt: timestamp() });
  return { id: reqID, userID: req.userID };
};

export const createIdResubmitRequest = async (userID, role, currentLicenseUrl, newLicenseUrl) => {
  if (!newLicenseUrl) {
    const err = new Error("newLicenseUrl is required.");
    err.statusCode = 400;
    throw err;
  }

  const ref = await db.collection("idResubmitRequests").add({
    userID,
    role,
    currentLicenseUrl: currentLicenseUrl || "",
    newLicenseUrl,
    status: "pending",
    requestedBy: userID,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  return { id: ref.id, userID };
};