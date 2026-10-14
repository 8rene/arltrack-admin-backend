import crypto from "crypto";
import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";

const COLLECTION = "termsVersions";
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const MAX_TITLE_LEN = 150;
const MAX_NOTE_LEN = 500;
// Bytes, not characters — express.json() rejects bodies over 100 kb, so stay under it.
const MAX_CONTENT_BYTES = 90000;

const normalize = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();
const hashOf = (title, content) =>
  crypto.createHash("sha256").update(`${title}\n${content}`).digest("hex");

const iso = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null);

// Firestore Timestamps don't serialize nicely to JSON — convert to ISO strings.
const shape = (id, data, { withContent = true } = {}) => {
  const out = {
    termsVersionID: id,
    version: data.version,
    title: data.title,
    changeNote: data.changeNote || "",
    contentHash: data.contentHash || "",
    contentLength: (data.content || "").length,
    createdAt: iso(data.createdAt),
    createdBy: data.createdBy || null,
  };
  if (withContent) out.content = data.content || "";
  return out;
};

// Newest version, or null if nothing has been saved yet.
export const getCurrentTerms = async () => {
  const snap = await db.collection(COLLECTION).orderBy("version", "desc").limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return shape(doc.id, doc.data());
};

// History list — metadata only (no content) so the list stays light.
export const listTermsVersions = async (limit = 50) => {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const snap = await db.collection(COLLECTION).orderBy("version", "desc").limit(n).get();
  return snap.docs.map((d) => shape(d.id, d.data(), { withContent: false }));
};

// One specific version, with content (for "view" / "restore").
export const getTermsVersion = async (id) => {
  const doc = await db.collection(COLLECTION).doc(String(id)).get();
  if (!doc.exists) return null;
  return shape(doc.id, doc.data());
};

// Create the next version. Runs in a transaction so two admins saving at the
// same moment can't both claim the same version number.
export const createTermsVersion = async (payload, actor) => {
  const title = normalize(payload?.title) || "Terms & Conditions";
  const content = normalize(payload?.content);
  const changeNote = normalize(payload?.changeNote);

  if (title.length > MAX_TITLE_LEN) {
    throw new Error(`Title must be ${MAX_TITLE_LEN} characters or fewer.`);
  }
  if (!content) {
    throw new Error("Terms content cannot be empty.");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("Terms content is too long (max about 90 KB of text).");
  }
  if (changeNote.length > MAX_NOTE_LEN) {
    throw new Error(`Change note must be ${MAX_NOTE_LEN} characters or fewer.`);
  }

  const contentHash = hashOf(title, content);
  const createdBy = actor
    ? { userID: actor.userID || actor.id || null, name: actor.name || actor.username || null }
    : null;

  const latestQuery = db.collection(COLLECTION).orderBy("version", "desc").limit(1);
  const newRef = db.collection(COLLECTION).doc();

  const version = await db.runTransaction(async (tx) => {
    const latestSnap = await tx.get(latestQuery);
    const latest = latestSnap.empty ? null : latestSnap.docs[0].data();

    if (latest && latest.contentHash === contentHash) {
      throw new Error("No changes detected — the Terms are identical to the current version.");
    }

    const nextVersion = latest ? latest.version + 1 : 1;
    tx.set(newRef, {
      termsVersionID: newRef.id,
      version: nextVersion,
      title,
      content,
      contentHash,
      changeNote,
      createdAt: timestamp(),
      createdBy,
    });
    return nextVersion;
  });

  const saved = await newRef.get();
  return shape(newRef.id, saved.data());
};
