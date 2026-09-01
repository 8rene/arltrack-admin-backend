import {
  upsertUserDocument,
  applyProfileChanges,
  approveProfileRequest,
  approveIdResubmitRequest,
  rejectRequest,
  createEditRequest,
  cancelEditRequest,
  createIdResubmitRequest,
} from "../../services/profileRequests/profileRequests.service.js";
import { createAuditLog } from "../../services/auditLogs/auditLogs.service.js";

// PUT /api/users/:uid/document
// Body: any subset of userDocument fields, e.g. { driverLicenseExpiry }.
// Used by ExpiryField (Users.jsx Documents tab) — was a direct
// updateDoc/addDoc pair with no role check or audit trail.
export const updateUserDocument = async (req, res) => {
  try {
    const { uid } = req.params;
    const fields = req.body || {};
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, message: "No fields provided." });
    }

    const data = await upsertUserDocument(uid, fields);

    createAuditLog({
      action: "update",
      description: `Updated document info for user ${uid} (${Object.keys(fields).join(", ")}).`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] updateUserDocument error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// POST /api/edit-requests/:id/approve
export const approveProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await approveProfileRequest(id);

    createAuditLog({
      action: "update",
      description: `Approved profile edit request for user ${data.userID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] approveProfile error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// POST /api/id-resubmit-requests/:id/approve
export const approveIdResubmit = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await approveIdResubmitRequest(id);

    createAuditLog({
      action: "update",
      description: `Approved ID resubmission for user ${data.userID}.`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] approveIdResubmit error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// PATCH /api/review-requests/:kind/:id/reject
// kind: "profile" | "id"
// Body: { note }
export const rejectReviewRequest = async (req, res) => {
  try {
    const { kind, id } = req.params;
    const { note } = req.body || {};
    if (!["profile", "id"].includes(kind)) {
      return res.status(400).json({ success: false, message: "kind must be 'profile' or 'id'." });
    }

    const data = await rejectRequest(kind, id, note);

    createAuditLog({
      action: "update",
      description: `Rejected ${kind === "profile" ? "profile edit" : "ID resubmission"} request for user ${data.userID}${note ? `: ${note}` : "."}`,
      userID: req.user?.uid || null,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] rejectReviewRequest error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ─────────────────────────────────────────────
// Self-service (Profile.jsx / Account.jsx) — the logged-in user acting on
// their OWN profile. Identity always comes from req.user (set by
// verifyToken), never from the request body, so nobody can edit or
// request changes for someone else's account by tampering the payload.
// ─────────────────────────────────────────────

// PUT /api/profile/fields
// Body: { changes: [{ field, collection, newValue }, ...] }
// Owner/Admin-only path (canEditDirectly on the frontend) — applies
// straight to the underlying docs, no approval step.
export const updateOwnProfileFields = async (req, res) => {
  try {
    const { changes } = req.body || {};
    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ success: false, message: "changes must be a non-empty array." });
    }

    await applyProfileChanges(req.user.uid, changes);

    createAuditLog({
      action: "update",
      description: `Updated own profile (${changes.map(c => c.field).join(", ")}).`,
      userID: req.user.uid,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] updateOwnProfileFields error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// POST /api/profile/edit-requests
// Body: { role, changes: [...] } — role is passed through as-is (it's
// display metadata for the reviewer, e.g. "Driver"), not used for any
// permission check here.
export const submitEditRequest = async (req, res) => {
  try {
    const { role, changes } = req.body || {};
    const data = await createEditRequest(req.user.uid, role || req.user.role || "", changes);

    createAuditLog({
      action: "update",
      description: `Submitted a profile edit request (${(changes || []).map(c => c.field).join(", ")}).`,
      userID: req.user.uid,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] submitEditRequest error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// PATCH /api/profile/edit-requests/:id/cancel
export const cancelOwnEditRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const data = await cancelEditRequest(id, req.user.uid);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] cancelOwnEditRequest error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// POST /api/profile/id-resubmit-requests
// Body: { role, currentLicenseUrl, newLicenseUrl } — newLicenseUrl is the
// downloadURL from a Storage upload the frontend already did; this
// endpoint only handles the Firestore doc, same pattern as the fleet
// image endpoint.
export const submitIdResubmitRequest = async (req, res) => {
  try {
    const { role, currentLicenseUrl, newLicenseUrl } = req.body || {};
    const data = await createIdResubmitRequest(
      req.user.uid,
      role || req.user.role || "",
      currentLicenseUrl,
      newLicenseUrl
    );

    createAuditLog({
      action: "update",
      description: `Submitted a driver's license resubmission for review.`,
      userID: req.user.uid,
    }).catch((err) => console.error("[PROFILE_REQUESTS] Failed to write audit log:", err));

    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[PROFILE_REQUESTS] submitIdResubmitRequest error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};