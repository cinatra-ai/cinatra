// Splice THIS round's records/results into the canonical index and this lane's
// own envelopes, and prove that NOTHING ELSE moved: every untouched record is
// hashed before and after and the two digests are compared against the committed
// head.
//
// cinatra#2997 — this round REPLACES the two `S3` records and ADDS six: the two
// working placeholders on each host, and the run page's own review pair. A cell
// that has no row yet is APPENDED rather than skipped, which is the one
// difference from `15`: that round only ever replaced.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const SRC = process.argv[2];
const HEAD = process.argv[3];
const newRecs = JSON.parse(fs.readFileSync(SRC + "/capture-records.json", "utf8"));
const newRes = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8"));
// THE PLACEHOLDER CELLS ARE NOT INDEX CELLS, and the reason is the index's own
// rule rather than a preference: a record in the canonical index is a CARD CLAIM,
// and the contract requires the claimed card's host anchor and root to have been
// counted on that screen. A placeholder screen has no card on it — that is what
// makes it a placeholder — so an index row for one could only ever be a claim
// with nothing behind it. They are recorded in this round's own envelope, graded
// in README.md, and left out of the index deliberately.
const INDEX_CELLS = new Set(newRecs.filter((r) => !r.cell.includes("review-placeholder")).map((r) => r.cell));
const CELLS = new Set(newRecs.map((r) => r.cell));
const recByCell = Object.fromEntries(newRecs.map((r) => [r.cell, r]));
const resByCell = Object.fromEntries(newRes.results.map((r) => [r.cell, r]));
// WHERE A CELL IS REPLACED, AND WHERE A NEW ONE IS ADDED, are different
// questions and the fifth column answers the second. The CANONICAL INDEX is the
// binding record for every cell in the tree, so a cell this round adds belongs in
// it. The per-round envelopes beside it are each ONE ROUND'S OWN artifact: a cell
// they never held must not appear in them (that would make a round's record claim
// pictures it never took), while a cell they DO hold is replaced, because its
// screenshot's bytes changed and a record that no longer matches its file is a
// false record.
const targets = [
  ["scripts/ci/chat-hitl-capture-index.json", "rec", (j) => j.records, null, true],
  ["evidence/2790-s9f-host-parity/capture-records.json", "rec", (j) => j, null, false],
  ["evidence/2790-s9f-host-parity/capture-records-chat.json", "rec", (j) => j, null, false],
  ["evidence/2790-s9f-host-parity/capture-records-review-reshoot.json", "rec", (j) => j, null, false],
  ["evidence/2790-s9f-host-parity/capture-results-chat.json", "res", (j) => j.results, (j) => j, false],
  ["evidence/2790-s9f-host-parity/capture-results-review-reshoot.json", "res", (j) => j.results, (j) => j, false],
];
const digestOfUntouched = (arr) =>
  crypto
    .createHash("sha256")
    .update(arr.filter((r) => !CELLS.has(r.cell)).map((r) => `${r.cell}:${crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex")}`).join("|"))
    .digest("hex");
const report = {};
for (const [file, kind, pick, envelope, mayAppend] of targets) {
  const atHead = JSON.parse(execFileSync("git", ["show", `${HEAD}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const headDigest = digestOfUntouched(pick(atHead));
  const raw = fs.readFileSync(file, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const j = JSON.parse(raw);
  const arr = pick(j);
  const beforeDigest = digestOfUntouched(arr);
  const spliced = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr[i].cell;
    if (!CELLS.has(c)) continue;
    arr[i] = kind === "res" ? resByCell[c] : recByCell[c];
    spliced.push(c);
    seen.add(c);
  }
  const appended = [];
  for (const c of mayAppend ? INDEX_CELLS : []) {
    if (seen.has(c)) continue;
    const row = kind === "res" ? resByCell[c] : recByCell[c];
    if (!row) continue;
    arr.push(row);
    appended.push(c);
  }
  // The envelope travels with its results: `wire` and `pageErrors` are
  // properties of the capture EXECUTION, not of a cell.
  if (kind === "res" && envelope) {
    const env = envelope(j);
    env.wire = newRes.wire;
    env.pageErrors = newRes.pageErrors;
  }
  const afterDigest = digestOfUntouched(pick(j));
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + (trailingNewline ? "\n" : ""));
  report[file] = {
    spliced: spliced.length,
    splicedCells: spliced,
    appended: appended.length,
    appendedCells: appended,
    untouchedAtHead: headDigest.slice(0, 16),
    untouchedBefore: beforeDigest.slice(0, 16),
    untouchedAfter: afterDigest.slice(0, 16),
    untouchedIdenticalToHead: headDigest === afterDigest,
  };
}
console.log(JSON.stringify(report, null, 2));
if (Object.values(report).some((r) => !r.untouchedIdenticalToHead)) {
  console.log("SPLICE FAILED: a record outside this round moved");
  process.exitCode = 1;
} else console.log("SPLICE OK: every record outside this round is byte-identical to the head");
