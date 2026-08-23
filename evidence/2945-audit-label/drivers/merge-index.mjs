// Replace the six re-shot cells' records IN PLACE in the canonical index.
// Records come from this lane's own results file, written by the shipped
// recorder; nothing here edits a record.
import fs from "node:fs";
import path from "node:path";

const REPO = process.env.CAP_REPO_ROOT;
const INDEX = path.join(REPO, "scripts/ci/chat-hitl-capture-index.json");
const RESULTS = path.join(REPO, "evidence/2945-audit-label/capture-results.json");
const CELLS = new Set(process.env.MERGE_CELLS.split(","));

const index = JSON.parse(fs.readFileSync(INDEX, "utf8"));
const results = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
const fresh = new Map(results.records.filter((r) => CELLS.has(r.cell)).map((r) => [r.cell, r]));
if (fresh.size !== CELLS.size) {
  throw new Error(`results carry ${fresh.size} of the ${CELLS.size} named cells`);
}
let replaced = 0;
index.records = index.records.map((r) => {
  const next = fresh.get(r.cell);
  if (!next) return r;
  replaced += 1;
  return next;
});
if (replaced !== CELLS.size) throw new Error(`replaced ${replaced}, expected ${CELLS.size}`);
fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
console.log(`replaced ${replaced} record(s); index carries ${index.records.length}`);
