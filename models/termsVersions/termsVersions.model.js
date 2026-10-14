// ─────────────────────────────────────────────
// termsVersions/{termsVersionID} — Firestore collection
// ─────────────────────────────────────────────
// Terms & Conditions, stored as Markdown text. APPEND-ONLY: every save
// creates a NEW doc with version = previous + 1. Old versions are never
// edited or deleted, so this collection is also the full history/audit
// trail of what customers agreed to at any point in time.
//
// "Current" T&C = the doc with the highest `version`.
//
// Kept OUT of systemSettings on purpose: systemSettings copies every field
// into a new snapshot on each save, so a long T&C would be duplicated every
// time someone changed a fee.
//
// Size: a Firestore doc can hold ~1 MiB. Content is capped at 90,000 bytes
// (see terms.service.js) — far above any real T&C, and safely under
// express.json()'s default 100 kb body limit.
//
// Recording acceptance (customer backend, at signup / re-accept):
//   users/{uid}.termsVersion    → the `version` number they accepted
//   users/{uid}.termsAcceptedAt → server timestamp
//   (optionally also store termsContentHash for proof of exact wording)

export const TermsVersion = {
  termsVersionID: null,  // mirrors this doc's own Firestore ID
  version: 1,            // integer, increments by 1 on every save
  title: "Terms & Conditions",
  content: "",           // Markdown
  contentHash: "",       // sha256(title + "\n" + content) — detects no-change saves
  changeNote: "",        // optional "what changed" note written by the editor
  createdAt: null,       // Firestore server timestamp
  createdBy: null,       // { userID, name } of the Owner/Admin who saved it
};
