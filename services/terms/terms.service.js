import admin from "firebase-admin";
import { db } from "../../config/firebaseConnection/firebase.js";

const COLLECTION = "termsVersions";
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();

const MAX_NOTE_LEN = 500;
// Bytes, not characters — express.json() rejects bodies over 100 kb, so stay under it.
const MAX_CONTENT_BYTES = 90000;

const normalize = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();

// Versions are compared in hundredths (1.01 -> 101) so there is no floating-point drift.
// Returns null unless the value is a number with at most 2 decimals.
const toCents = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  return Math.abs(n * 100 - c) > 1e-6 ? null : c;
};
const fmtVersion = (cents) => (cents / 100).toFixed(2);

const iso = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null);

// Firestore Timestamps don't serialize nicely to JSON — convert to ISO strings.
const shape = (id, data, { withContent = true } = {}) => {
  const out = {
    termsVersionID: id,
    version: data.version,
    changeNote: data.changeNote || "",
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

// Bookings made BEFORE the customer app switched to termsVersions were accepted against a
// hash in `termsSnapshots/{hash}` ({ version, sections:[{ title, highlight?, body?, list?, footer? }] }).
// Read-only: converted to the same Markdown shape so those old agreements can still be opened.
const sectionsToMarkdown = (sections = []) => {
  const out = ["# ARL Car Rental — Terms & Conditions", ""];
  sections.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.title}`, "");
    if (s.highlight) out.push(`**${s.highlight}**`, "");
    if (s.body) out.push(s.body, "");
    if (Array.isArray(s.list)) { s.list.forEach((it) => out.push(`- **${it.label}:** ${it.value}`)); out.push(""); }
    if (s.footer) out.push(s.footer, "");
  });
  return out.join("\n").replace(/\n+$/, "\n");
};

const getLegacyTermsByHash = async (hash) => {
  const doc = await db.collection("termsSnapshots").doc(String(hash)).get();
  if (!doc.exists) return null;
  const snap = doc.data();
  return {
    termsVersionID: null,
    version: snap.version ?? null,
    changeNote: "",
    contentLength: 0,
    createdAt: null,
    createdBy: null,
    content: sectionsToMarkdown(snap.sections),
    legacy: true,
  };
};

// One specific version, with content (for "view" / "restore").
// `id` is normally a termsVersions doc ID; if there is no such doc it may be the hash of an
// older (pre-termsVersions) agreement, which is read from termsSnapshots instead.
export const getTermsVersion = async (id) => {
  const doc = await db.collection(COLLECTION).doc(String(id)).get();
  if (doc.exists) return shape(doc.id, doc.data());
  return getLegacyTermsByHash(id);
};

// Create the next version. Runs in a transaction so two admins saving at the
// same moment can't both claim the same version number.
export const createTermsVersion = async (payload, actor) => {
  const content = normalize(payload?.content);
  const changeNote = normalize(payload?.changeNote);

  if (!content) {
    throw new Error("Terms content cannot be empty.");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new Error("Terms content is too long (max about 90 KB of text).");
  }
  if (changeNote.length > MAX_NOTE_LEN) {
    throw new Error(`Change note must be ${MAX_NOTE_LEN} characters or fewer.`);
  }

  const createdBy = actor
    ? { userID: actor.userID || actor.id || null, name: actor.name || actor.username || null }
    : null;

  const latestQuery = db.collection(COLLECTION).orderBy("version", "desc").limit(1);
  const newRef = db.collection(COLLECTION).doc();

  const version = await db.runTransaction(async (tx) => {
    const latestSnap = await tx.get(latestQuery);
    const latest = latestSnap.empty ? null : latestSnap.docs[0].data();

    // Compare the text itself so identical content can't be published as a new version.
    if (latest && latest.content === content) {
      throw new Error("No changes detected — the Terms are identical to the current version.");
    }

    // Version: editor's choice, must be strictly higher than the current one.
    // If none is sent, default to the next step (+0.01).
    const latestCents = latest ? toCents(latest.version) ?? Math.round(Number(latest.version) * 100) : 0;
    const asked = payload?.version;
    const hasAsked = asked !== undefined && asked !== null && String(asked).trim() !== "";
    const cents = hasAsked ? toCents(asked) : (latest ? latestCents + 1 : 100);
    if (cents === null || cents < 100) {
      throw new Error("Version must be a number like 1.00 or 1.01 (2 decimals, at least 1.00).");
    }
    if (latest && cents <= latestCents) {
      throw new Error(`Version must be higher than the current version (${fmtVersion(latestCents)}).`);
    }
    const nextVersion = cents / 100;
    tx.set(newRef, {
      termsVersionID: newRef.id,
      version: nextVersion,
      content,
      changeNote,
      createdAt: timestamp(),
      createdBy,
    });
    return nextVersion;
  });

  const saved = await newRef.get();
  return shape(newRef.id, saved.data());
};