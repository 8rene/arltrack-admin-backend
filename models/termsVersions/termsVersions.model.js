// ─────────────────────────────────────────────
// termsVersions/{termsVersionID} — Firestore collection
// ─────────────────────────────────────────────
// Terms & Conditions, stored as Markdown text. APPEND-ONLY: every save
// creates a NEW doc. The editor chooses the version number (1.00, 1.01, 2.00 …)
// but it must always be HIGHER than the current one. Old versions are never
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
// Recording acceptance (customer backend, when the booking is created):
//   bookings/{id}.termsVersionID  → this doc's ID (the exact text they agreed to)
//   bookings/{id}.termsAcceptedAt → server timestamp

export const TermsVersion = {
  termsVersionID: null,  // mirrors this doc's own Firestore ID
  version: 1.0,          // number with 2 decimals (1.00, 1.01, 2.00). Chosen by the editor, always > previous.
                         // Old whole numbers (1, 2, 3) are simply 1.00, 2.00, 3.00 — no migration.
  content: "",           // Markdown
  changeNote: "",        // optional "what changed" note written by the editor
  createdAt: null,       // Firestore server timestamp
  createdBy: null,       // { userID, name } of the Owner/Admin who saved it
};