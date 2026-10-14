import {
  getCurrentTerms,
  listTermsVersions,
  getTermsVersion,
  createTermsVersion,
} from "../../services/terms/terms.service.js";

// GET /api/terms/current  — PUBLIC (no login), used by signup / T&C modal.
// Returns only what a customer needs. data is null if nothing is published
// yet; clients fall back to their built-in default text.
export const getPublicTerms = async (req, res) => {
  try {
    const t = await getCurrentTerms();
    res.set("Cache-Control", "public, max-age=60");
    if (!t) return res.status(200).json({ success: true, data: null });
    const { termsVersionID, version, title, content, contentHash, createdAt } = t;
    return res.status(200).json({
      success: true,
      data: { termsVersionID, version, title, content, contentHash, effectiveAt: createdAt },
    });
  } catch (error) {
    console.error("[TERMS] getPublicTerms error:", error);
    return res.status(500).json({ success: false, message: "Failed to load Terms." });
  }
};

// GET /api/settings/terms  — Owner/Admin: current version (or data: null)
export const getCurrent = async (req, res) => {
  try {
    const data = await getCurrentTerms();
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[TERMS] getCurrent error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/settings/terms/versions?limit=50  — history (no content)
export const listVersions = async (req, res) => {
  try {
    const data = await listTermsVersions(req.query.limit);
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[TERMS] listVersions error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/settings/terms/versions/:id  — one version with content
export const getVersion = async (req, res) => {
  try {
    const data = await getTermsVersion(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: "Version not found." });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[TERMS] getVersion error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/settings/terms
// Body: { title?, content, changeNote? } → creates the NEXT version.
export const createVersion = async (req, res) => {
  try {
    const actor = req.user ? { userID: req.user.uid, name: req.user.email } : null;
    const data = await createTermsVersion(req.body || {}, actor);
    return res.status(201).json({ success: true, data });
  } catch (error) {
    console.error("[TERMS] createVersion error:", error);
    return res.status(400).json({ success: false, message: error.message });
  }
};
