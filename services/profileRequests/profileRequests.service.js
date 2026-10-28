import { db } from "../../config/firebaseConnection/firebase.js";
import admin from "firebase-admin";
import { randomUUID } from "crypto";
import { resolveNotification, createNotification } from "../notification/notification.service.js";

const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const notFound = (message) => {
  const err = new Error(message);
  err.statusCode = 404;
  throw err;
};

const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
};

// Which fields a self-service profile edit / edit request may touch, per
// collection. applyProfileChanges() writes whatever it is given straight
// onto the doc, so without this list a caller could send e.g.
// { collection: "user", field: "roleID" } or { field: "status" } and
// change their own role or unlock their own account. Keep this in sync
// with EDITABLE_FIELDS in Account.jsx / Profile.jsx.
const ALLOWED_PROFILE_FIELDS = {
  user:        new Set(["username", "phone"]),
  userDetails: new Set(["firstName", "middleName", "lastName", "suffix", "birthDate"]),
  userAddress: new Set([
    "street", "barangay", "municipality", "city", "province",
    "postalCode", "village", "region",
  ]),
};

// Fields that used to be editable but were retired. zipCode was merged into postalCode (see
// scripts/migrateZipToPostal.js). Old pending edit requests and stale open browser tabs can still
// send it, so it is dropped quietly instead of erroring or writing the field back onto the address.
const RETIRED_FIELDS = new Set(["userAddress.zipCode"]);
const dropRetiredFields = (changes) =>
  (Array.isArray(changes) ? changes : []).filter((c) => !RETIRED_FIELDS.has(`${c?.collection}.${c?.field}`));

const assertAllowedChanges = (changes) => {
  for (const c of changes) {
    const allowed = ALLOWED_PROFILE_FIELDS[c?.collection];
    if (!allowed || !allowed.has(c?.field)) {
      badRequest(`Field "${c?.field}" in "${c?.collection}" cannot be edited here.`);
    }
  }
};

// Tells the requester (not the reviewer) what happened to their own
// request — mirrors refundRequest.service.js's notifyCustomer helper.
// refCollection is "account" so Header.jsx's click-through just lands
// the requester back on their own Account page; there's no per-request
// detail view to deep-link into the way a booking/refund has.
const notifyRequester = (userID, reqID, type, title, message) => {
  if (!userID) return Promise.resolve();
  return createNotification({ type, refID: reqID, refCollection: "account", title, message, userID })
    .catch((err) => console.error(`[PROFILE_REQUESTS] failed to notify requester (${type}):`, err.message));
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

// A photo URL sent by the browser must be a Firebase Storage upload in the given folder, named for this user, so it
// cannot be an arbitrary or external image. The selfie with ID is uploaded to the same "documentResubmit" folder as the
// ID photo (the folder the Storage rules already allow for this flow); only its file name tells them apart.
const assertOwnUpload = (url, folder, userID, label) => {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch { badRequest(`${label} must be a valid URL.`); }
  let objectPath = "";
  try { objectPath = decodeURIComponent(parsed.pathname.split("/o/")[1] || ""); } catch { /* checked below */ }
  if (parsed.protocol !== "https:" || parsed.hostname !== "firebasestorage.googleapis.com" || !objectPath.startsWith(`${folder}/${userID}_`)) {
    badRequest(`${label} must be a Firebase Storage upload for this user.`);
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
    // A document the admin created before this fix has no userDocumentID of its own; give it one (customer signup always does).
    const hasOwnID = !!existing.docs[0].data().userDocumentID;
    await existing.docs[0].ref.update({ ...(hasOwnID ? {} : { userDocumentID: randomUUID() }), ...fields, updatedAt: timestamp() });
    return { id: existing.docs[0].id, userID, ...fields };
  }

  // No document yet: create it with the SAME field set the customer signup writes (customer backend,
  // models/user/userDocument.model.js), so every reader finds every field and the document has its own userDocumentID.
  const blank = {
    userDocumentID: randomUUID(),
    userID,
    documentType: "",
    documentNumber: "",
    documentImageUrl: "",
    driversLicenseNumber: "",
    driverLicenseUrl: "",
    selfieWithIdUrl: "",
  };
  const ref = await db.collection("userDocument").add({ ...blank, ...fields, createdAt: timestamp() });
  return { id: ref.id, userID, ...blank, ...fields };
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
export const applyProfileChanges = async (userID, rawChanges = []) => {
  const changes = dropRetiredFields(rawChanges);
  if (!changes.length) return; // nothing left to write (e.g. only a retired field was sent)
  assertAllowedChanges(changes);
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
export const approveProfileRequest = async (reqID, adminUid) => {
  const ref = db.collection("editRequests").doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("Edit request not found.");
  const req = snap.data();

  await requireLiveUser(req.userID);
  await applyProfileChanges(req.userID, req.changes || []);
  await ref.update({ status: "approved", reviewedBy: adminUid || null, reviewedAt: timestamp(), updatedAt: timestamp() });

  resolveNotification("edit_request", reqID)
    .catch((err) => console.error("[NOTIF] Failed to resolve edit_request:", err.message));

  notifyRequester(
    req.userID, reqID, "profile_edit_approved", "Profile Update Approved",
    "Your profile update request has been approved and is now live on your account."
  );

  return { id: reqID, userID: req.userID };
};

// ─────────────────────────────────────────────
// idResubmitRequests — new license or document photo submissions.
// License approval requires the reviewer to enter the expiry date shown
// on the new card in the same action — a resubmitted license can easily
// have a different expiry than the one on file, so leaving the old date
// in place (the old behavior) risked it silently going stale/wrong.
// Document (government ID etc.) has no expiry concept, so that branch
// just swaps the photo.
// ─────────────────────────────────────────────
export const approveIdResubmitRequest = async (reqID, driverLicenseExpiry, adminUid) => {
  const ref = db.collection("idResubmitRequests").doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("ID resubmit request not found.");
  const req = snap.data();

  // Existing requests created before documentKind existed were always
  // license — treat a missing field as "license", not an error.
  const kind = req.documentKind || "license";

  await requireLiveUser(req.userID);

  if (kind === "license") {
    if (!driverLicenseExpiry) {
      const err = new Error("driverLicenseExpiry is required when approving a license resubmission.");
      err.statusCode = 400;
      throw err;
    }
    await upsertUserDocument(req.userID, {
      driverLicenseUrl: req.newLicenseUrl,
      driverLicenseExpiry,
      // Only when the request carried one (requests from the customer app don't).
      ...(req.driversLicenseNumber ? { driversLicenseNumber: req.driversLicenseNumber } : {}),
    });
  } else {
    // documentType/documentNumber were captured at submission time (the
    // requester typed them alongside the photo, same as the original
    // signup flow) — carried over here rather than re-entered by the
    // reviewer, since there's no per-card verification concept for these
    // two fields the way there is for a license's expiry date.
    await upsertUserDocument(req.userID, {
      documentImageUrl: req.newDocumentUrl,
      ...(req.documentType   !== undefined ? { documentType: req.documentType } : {}),
      ...(req.documentNumber !== undefined ? { documentNumber: req.documentNumber } : {}),
      // The selfie holding the ID travels with a government ID. Requests that came without one (the customer app doesn't
      // send it) keep the selfie already on file instead of blanking it.
      ...(req.newSelfieUrl ? { selfieWithIdUrl: req.newSelfieUrl } : {}),
    });
  }

  await ref.update({ status: "approved", reviewedBy: adminUid || null, reviewedAt: timestamp(), updatedAt: timestamp() });

  resolveNotification("id_resubmit_request", reqID)
    .catch((err) => console.error("[NOTIF] Failed to resolve id_resubmit_request:", err.message));

  notifyRequester(
    req.userID, reqID, "id_resubmit_approved",
    kind === "license" ? "License Update Approved" : "Document Update Approved",
    kind === "license"
      ? "Your driver's license resubmission has been approved."
      : "Your document resubmission has been approved."
  );

  return { id: reqID, userID: req.userID, documentKind: kind };
};

// ─────────────────────────────────────────────
// Shared reject path for both request kinds.
// ─────────────────────────────────────────────
export const rejectRequest = async (kind, reqID, note, adminUid) => {
  const col = kind === "profile" ? "editRequests" : "idResubmitRequests";
  const ref = db.collection(col).doc(reqID);
  const snap = await ref.get();
  if (!snap.exists) notFound("Request not found.");
  const req = snap.data();

  await ref.update({
    status: "rejected",
    reviewNote: note || null,
    reviewedBy: adminUid || null,
    reviewedAt: timestamp(),
    updatedAt: timestamp(),
  });

  const reasonSuffix = note ? ` Reason: ${note}` : "";

  if (kind === "profile") {
    resolveNotification("edit_request", reqID)
      .catch((err) => console.error("[NOTIF] Failed to resolve edit_request:", err.message));

    notifyRequester(
      req.userID, reqID, "profile_edit_rejected", "Profile Update Rejected",
      `Your profile update request was rejected.${reasonSuffix}`
    );
  } else {
    resolveNotification("id_resubmit_request", reqID)
      .catch((err) => console.error("[NOTIF] Failed to resolve id_resubmit_request:", err.message));

    const isLicense = (req.documentKind || "license") === "license";
    notifyRequester(
      req.userID, reqID, "id_resubmit_rejected",
      isLicense ? "License Update Rejected" : "Document Update Rejected",
      `Your ${isLicense ? "driver's license" : "document"} resubmission was rejected.${reasonSuffix}`
    );
  }

  return { id: reqID, userID: req.userID };
};

// ─────────────────────────────────────────────
// Account deleted: every PENDING edit / ID resubmit request of that user is rejected, so it leaves the review queue
// instead of sitting there for an account that no longer exists. Called by deleteUser() in
// controllers/user/user.controller.js. The requester is NOT notified (the account is gone) and nothing is deleted
// here: the requests stay until the archived user is permanently deleted (deleteUserArchive in
// services/archives/userArchives.service.js), so a restore or merge still finds them.
// ─────────────────────────────────────────────
export const closePendingRequestsForUser = async (userID, closedBy) => {
  const out = { editRequests: 0, idResubmitRequests: 0 };
  if (!userID) return out;
  const kinds = [
    ["editRequests", "edit_request"],
    ["idResubmitRequests", "id_resubmit_request"],
  ];
  for (const [col, notifType] of kinds) {
    const snap = await db.collection(col).where("userID", "==", userID).where("status", "==", "pending").get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      snap.docs.slice(i, i + 400).forEach((d) => batch.update(d.ref, {
        status: "rejected",
        reviewNote: "Account deleted.",
        reviewedBy: closedBy || null,
        reviewedAt: timestamp(),
        updatedAt: timestamp(),
      }));
      await batch.commit();
    }
    snap.docs.forEach((d) => resolveNotification(notifType, d.id)
      .catch((err) => console.error(`[NOTIF] Failed to resolve ${notifType}:`, err.message)));
    out[col] = snap.size;
  }
  return out;
};

// ─────────────────────────────────────────────
// Self-service: a user submitting a request about their OWN profile.
// userID always comes from the verified token (req.user.uid) in the
// controller, never from the request body — otherwise anyone could
// submit an edit request that claims to be from a different user.
// ─────────────────────────────────────────────
export const createEditRequest = async (userID, role, rawChanges) => {
  const changes = dropRetiredFields(rawChanges);
  if (changes.length === 0) {
    const err = new Error("changes must be a non-empty array.");
    err.statusCode = 400;
    throw err;
  }

  assertAllowedChanges(changes);

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

// documentKind: "license" | "document". Field names stay split by kind
// (currentLicenseUrl/newLicenseUrl vs currentDocumentUrl/newDocumentUrl)
// rather than one generic pair — keeps any already-pending "license"
// requests readable under their original field names with no migration
// needed, since documentKind didn't exist before this.
// documentType/documentNumber are only meaningful for documentKind ===
// "document" — the requester types these alongside the new photo (same
// as the original signup flow), and they're carried straight through to
// userDocument on approval; see approveIdResubmitRequest.
export const createIdResubmitRequest = async (userID, role, documentKind, currentUrl, newUrl, documentType, documentNumber, extra = {}) => {
  if (!["license", "document"].includes(documentKind)) {
    const err = new Error("documentKind must be 'license' or 'document'.");
    err.statusCode = 400;
    throw err;
  }
  if (!newUrl) {
    const err = new Error("newUrl is required.");
    err.statusCode = 400;
    throw err;
  }

  // extra: { currentSelfieUrl, newSelfieUrl, driversLicenseNumber }
  const { currentSelfieUrl, newSelfieUrl, driversLicenseNumber } = extra || {};
  if (documentKind === "document") {
    // Same rule as the customer app: a government ID needs its type and number, and the selfie holding it is the proof.
    // A driver's license needs neither the type nor the selfie.
    if (!String(documentType || "").trim() || !String(documentNumber || "").trim()) {
      badRequest("documentType and documentNumber are required for a document resubmission.");
    }
    if (!newSelfieUrl) badRequest("A selfie holding the ID is required when submitting a government ID.");
    assertOwnUpload(newSelfieUrl, "documentResubmit", userID, "newSelfieUrl");
  }

  const urlFields = documentKind === "license"
    ? {
        currentLicenseUrl: currentUrl || "",
        newLicenseUrl: newUrl,
        ...(String(driversLicenseNumber || "").trim() ? { driversLicenseNumber: String(driversLicenseNumber).trim() } : {}),
      }
    : {
        currentDocumentUrl: currentUrl || "",
        newDocumentUrl: newUrl,
        documentType: String(documentType).trim(),
        documentNumber: String(documentNumber).trim(),
        currentSelfieUrl: currentSelfieUrl || "",
        newSelfieUrl,
      };

  const ref = await db.collection("idResubmitRequests").add({
    userID,
    role,
    documentKind,
    ...urlFields,
    status: "pending",
    requestedBy: userID,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: timestamp(),
    updatedAt: timestamp(),
  });
  return { id: ref.id, userID, documentKind };
};

// ─────────────────────────────────────────────
// Self-service, Owner/Admin only: applies a license or document update
// directly, no approval step — same trust boundary as
// applyProfileChanges()'s canEditDirectly path. Role is enforced at the
// route level (requireRole), not here, matching the rest of this file.
// One audit entry gets logged by the controller for this, since there's
// no separate submit+approve pair to log for a direct apply.
// ─────────────────────────────────────────────
export const applyOwnDocumentUpdate = async (userID, documentKind, newUrl, driverLicenseExpiry, documentType, documentNumber, newSelfieUrl, driversLicenseNumber) => {
  if (!["license", "document"].includes(documentKind)) {
    const err = new Error("documentKind must be 'license' or 'document'.");
    err.statusCode = 400;
    throw err;
  }
  if (!newUrl) {
    const err = new Error("newUrl is required.");
    err.statusCode = 400;
    throw err;
  }

  if (documentKind === "license") {
    if (!driverLicenseExpiry) {
      const err = new Error("driverLicenseExpiry is required when updating a license.");
      err.statusCode = 400;
      throw err;
    }
    await upsertUserDocument(userID, {
      driverLicenseUrl: newUrl,
      driverLicenseExpiry,
      ...(driversLicenseNumber !== undefined ? { driversLicenseNumber } : {}),
    });
  } else {
    // Government ID: the selfie holding it goes with the photo (a driver's license has no selfie).
    if (!newSelfieUrl) {
      const err = new Error("A selfie holding the ID is required when replacing a government ID.");
      err.statusCode = 400;
      throw err;
    }
    assertOwnUpload(newSelfieUrl, "documentResubmit", userID, "newSelfieUrl");
    await upsertUserDocument(userID, {
      documentImageUrl: newUrl,
      selfieWithIdUrl: newSelfieUrl,
      ...(documentType   !== undefined ? { documentType } : {}),
      ...(documentNumber !== undefined ? { documentNumber } : {}),
    });
  }

  return { userID, documentKind };
};

// ─────────────────────────────────────────────
// Profile photo — the browser uploads the file to Firebase Storage at
// avatars/{uid} and sends us the resulting download URL; this stores it
// on the caller's own user doc. The URL is checked so a caller can only
// point profileImage at their own avatar object, not an arbitrary
// (possibly external) image.
// ─────────────────────────────────────────────
export const setOwnAvatar = async (userID, profileImage) => {
  const url = typeof profileImage === "string" ? profileImage.trim() : "";
  if (!url) badRequest("profileImage is required.");

  let parsed;
  try { parsed = new URL(url); } catch { badRequest("profileImage must be a valid URL."); }

  const objectPart = parsed.pathname.split("/o/")[1] || "";
  let objectPath = "";
  try { objectPath = decodeURIComponent(objectPart); } catch { /* falls through to the check below */ }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "firebasestorage.googleapis.com" ||
    objectPath !== `avatars/${userID}`
  ) {
    badRequest("profileImage must be a Firebase Storage URL for your own avatar.");
  }

  await db.collection("user").doc(userID).update({ profileImage: url, updatedAt: timestamp() });
  return { profileImage: url };
};

// ─────────────────────────────────────────────
// Admin direct edits (Owner/Admin only — enforced at the route). Unlike the self-service paths above, these act on SOMEONE
// ELSE'S account, so they write an old → new trail for the audit log. Email is deliberately not editable here: it is not in
// ALLOWED_PROFILE_FIELDS, so assertAllowedChanges() rejects it.
// ─────────────────────────────────────────────
const plainValue = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v?.toDate === "function") return v.toDate().toISOString().slice(0, 10); // Firestore Timestamp (birthDate)
  return String(v).trim();
};

// referralCode is editable here (admin only) but is NOT in ALLOWED_PROFILE_FIELDS on purpose: that list is also used by the
// self-service paths, and users must not be able to pick their own code. Same look as generated codes (ARL-XXXXXXXX), but
// the admin may type a custom one: 4–20 letters / digits / hyphens, stored upper-case, unique across all users.
const REFERRAL_CODE_RE = /^[A-Z0-9-]{4,20}$/;

export const adminUpdateUserProfile = async (userID, rawChanges) => {
  await requireLiveUser(userID);
  const all = dropRetiredFields(rawChanges);
  if (!all.length) badRequest("No changes provided.");

  const codeChange = all.find((c) => c?.collection === "user" && c?.field === "referralCode");
  const referredChange = all.find((c) => c?.collection === "referral" && c?.field === "referredByCode");
  const changes = all.filter((c) => c !== codeChange && c !== referredChange);
  assertAllowedChanges(changes);

  const userSnap = await db.collection("user").doc(userID).get();
  const before = { user: userSnap.data() || {} };
  for (const col of [...new Set(changes.map((c) => c.collection))]) {
    if (col === "user") continue;
    const snap = await db.collection(col).where("userID", "==", userID).limit(1).get();
    before[col] = snap.empty ? {} : snap.docs[0].data();
  }

  // Checked BEFORE anything is written, so a bad referral code cannot leave the other edits half-applied.
  let newCode = null;
  if (codeChange) {
    const code = String(codeChange.newValue ?? "").trim().toUpperCase();
    if (!REFERRAL_CODE_RE.test(code)) badRequest("Referral code must be 4–20 characters: letters, numbers or hyphens.");
    if (code !== plainValue(before.user.referralCode)) {
      const dup = await db.collection("user").where("referralCode", "==", code).limit(1).get();
      if (!dup.empty && dup.docs[0].id !== userID) {
        const err = new Error(`The referral code "${code}" is already used by another account.`);
        err.statusCode = 409;
        throw err;
      }
      newCode = code;
    }
  }

  // "Referred by" is edited as the REFERRER's code. The link lives in the "referrals" table ({ referrerUserID, referredUserID }),
  // written by the customer backend at signup; here the admin can set, change or clear it. Everything is validated before any write.
  let referral = null;   // { oldRows, oldReferrerCode, newReferrerID|null, newReferrerCode|null }
  if (referredChange) {
    const wanted = String(referredChange.newValue ?? "").trim().toUpperCase();
    const oldRows = await db.collection("referrals").where("referredUserID", "==", userID).get();
    const oldReferrerID = oldRows.empty ? null : oldRows.docs[0].data().referrerUserID;
    let oldReferrerCode = "";
    if (oldReferrerID) oldReferrerCode = plainValue((await db.collection("user").doc(oldReferrerID).get()).data()?.referralCode);

    let newReferrerID = null;
    if (wanted) {
      if (!REFERRAL_CODE_RE.test(wanted)) badRequest("Referred-by code must be a referral code like ARL-ABCD1234.");
      const found = await db.collection("user").where("referralCode", "==", wanted).limit(1).get();
      if (found.empty) badRequest(`No account has the referral code "${wanted}".`);
      newReferrerID = found.docs[0].id;
      if (newReferrerID === userID) badRequest("A user can't be referred by their own code.");
      // no loops: if this user already referred the new referrer, A → B → A would result
      const loop = await db.collection("referrals").where("referrerUserID", "==", userID).where("referredUserID", "==", newReferrerID).limit(1).get();
      if (!loop.empty) badRequest("That account was referred by this user, so it can't also be their referrer.");
    }
    if (newReferrerID !== oldReferrerID) {
      referral = { oldRows, oldReferrerCode, newReferrerID, newReferrerCode: wanted || "" };
    }
  }

  // trim text and skip anything that is already that value
  const effective = changes
    .map((c) => ({ ...c, newValue: typeof c.newValue === "string" ? c.newValue.trim() : c.newValue }))
    .filter((c) => plainValue(before[c.collection]?.[c.field]) !== plainValue(c.newValue));

  if (effective.length) await applyProfileChanges(userID, effective);
  if (newCode) await userSnap.ref.update({ referralCode: newCode, updatedAt: timestamp() });
  if (referral) {
    const batch = db.batch();
    referral.oldRows.docs.forEach((d) => batch.delete(d.ref));
    if (referral.newReferrerID) {
      const ref = db.collection("referrals").doc();
      batch.set(ref, { referralID: ref.id, referrerUserID: referral.newReferrerID, referredUserID: userID, createdAt: timestamp() });
    }
    await batch.commit();
  }

  const changed = effective.map((c) => ({ field: c.field, from: plainValue(before[c.collection]?.[c.field]), to: plainValue(c.newValue) }));
  if (newCode) changed.push({ field: "referralCode", from: plainValue(before.user.referralCode), to: newCode });
  if (referral) changed.push({ field: "referredBy", from: referral.oldReferrerCode, to: referral.newReferrerCode });
  return { userID, changed };
};

// Replace a user's license / ID photo directly (no review step — the admin IS the reviewer). The browser uploads the file to
// Storage first; the URL must point at that user's own upload folder, so it cannot be an arbitrary or external image.
export const adminReplaceUserDocument = async (userID, { documentKind, newUrl, driverLicenseExpiry, documentType, documentNumber, newSelfieUrl, driversLicenseNumber }) => {
  await requireLiveUser(userID);
  if (!["license", "document"].includes(documentKind)) badRequest("documentKind must be 'license' or 'document'.");

  const folder = documentKind === "license" ? "driverLicenseResubmit" : "documentResubmit";
  assertOwnUpload(newUrl, folder, userID, "newUrl");
  if (documentKind === "license" && !driverLicenseExpiry) badRequest("driverLicenseExpiry is required when replacing a license.");
  if (documentKind === "document" && (!String(documentType || "").trim() || !String(documentNumber || "").trim())) {
    badRequest("documentType and documentNumber are required when replacing an ID document.");
  }

  return applyOwnDocumentUpdate(
    userID, documentKind, newUrl, driverLicenseExpiry,
    documentType === undefined ? undefined : String(documentType).trim(),
    documentNumber === undefined ? undefined : String(documentNumber).trim(),
    newSelfieUrl,
    driversLicenseNumber === undefined ? undefined : String(driversLicenseNumber).trim(),
  );
};