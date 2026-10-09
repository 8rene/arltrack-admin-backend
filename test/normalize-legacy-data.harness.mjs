// Runs scripts/normalize-legacy-data.js against a real export loaded into the in-memory fake Firestore.
//   node test/normalize-legacy-data.harness.mjs <export-dir> [script flags...]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeFakeDb } from "./fakeFirestore.mjs";
import { main } from "../scripts/normalize-legacy-data.js";

const [dir, ...flags] = process.argv.slice(2);
const revive = (v) => {
  if (v === null || typeof v !== "object") return v;
  if (v.__type === "timestamp") return new Date(v.iso);
  if (Array.isArray(v)) return v.map(revive);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
};
const seed = {};
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".json") || f === "manifest.json") continue;
  seed[f.replace(".json", "")] = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).map((r) => [r.id, revive(r.data)]));
}
const fake = makeFakeDb(seed);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "norm-"));
const report = await main({ db: fake.db, FieldValue: fake.FieldValue, argv: flags, outDir, now: new Date("2026-10-09T00:00:00Z") });
globalThis.__fake = fake; globalThis.__out = outDir;
if (process.env.DUMP) {
  const o = {};
  for (const n of ["bookings","payments","paymentEntries","driverAssignments","refundRequests","cancellationRequests","penalties"]) o[n] = [...fake.raw(n).entries()].map(([id, d]) => ({ id, ...d }));
  fs.writeFileSync(process.env.DUMP, JSON.stringify(o));
}
console.log("\nreport:", report.file, "  outDir:", outDir);
