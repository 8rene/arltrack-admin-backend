// Deletes Firebase Storage files that a permanently deleted record pointed at (inspection photos, the GPS history JSON).
//
// Nothing is deleted when something is ARCHIVED: archive copies keep the same URLs, so a restore still shows the
// photos. Files are removed only on a permanent delete, and only when the URL belongs to THIS project's bucket.
// Best effort: a file that cannot be deleted never blocks the database delete; the result reports what happened.
import { bucket } from "../../config/firebaseConnection/firebase.js";

// https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<encoded path>?alt=media&token=...  or
// https://storage.googleapis.com/<bucket>/<path>
export const storagePathFromUrl = (url) => {
  if (typeof url !== "string" || !url.startsWith("http")) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  let urlBucket = null;
  let path = null;
  if (u.hostname === "firebasestorage.googleapis.com") {
    const m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (m) { urlBucket = m[1]; path = decodeURIComponent(m[2]); }
  } else if (u.hostname === "storage.googleapis.com") {
    const m = u.pathname.match(/^\/([^/]+)\/(.+)$/);
    if (m) { urlBucket = m[1]; path = decodeURIComponent(m[2]); }
  }
  if (!path || !urlBucket || urlBucket !== bucket.name) return null; // someone else's bucket / not a storage URL: leave alone
  return path;
};

// every string anywhere inside `value` that is a storage URL of this bucket
export const collectStorageUrls = (value, out = new Set()) => {
  if (typeof value === "string") { if (storagePathFromUrl(value)) out.add(value); }
  else if (Array.isArray(value)) value.forEach((v) => collectStorageUrls(v, out));
  else if (value && typeof value === "object" && typeof value.toDate !== "function") Object.values(value).forEach((v) => collectStorageUrls(v, out));
  return out;
};

export const deleteStorageFiles = async (urls = []) => {
  const paths = [...new Set([...urls].map(storagePathFromUrl).filter(Boolean))];
  let deleted = 0;
  let failed = 0;
  for (const path of paths) {
    try { await bucket.file(path).delete({ ignoreNotFound: true }); deleted += 1; }
    catch (err) { failed += 1; console.error(`[STORAGE] could not delete ${path}:`, err.message); }
  }
  return { deleted, failed };
};