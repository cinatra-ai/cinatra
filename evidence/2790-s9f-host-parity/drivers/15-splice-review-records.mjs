// Splice THIS round's six records/results into the canonical index and this
// lane's own envelopes, and prove that NOTHING ELSE moved: every untouched
// record is hashed before and after and the two digests are compared against
// the committed head.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const SRC = process.argv[2];
const HEAD = process.argv[3];
const newRecs = JSON.parse(fs.readFileSync(SRC + "/capture-records.json", "utf8"));
const newRes = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8"));
const CELLS = new Set(newRecs.map((r) => r.cell));
const recByCell = Object.fromEntries(newRecs.map((r) => [r.cell, r]));
const resByCell = Object.fromEntries(newRes.results.map((r) => [r.cell, r]));
const targets = [
  ["scripts/ci/chat-hitl-capture-index.json", "rec", (j) => j.records, null],
  ["evidence/2790-s9f-host-parity/capture-records.json", "rec", (j) => j, null],
  ["evidence/2790-s9f-host-parity/capture-records-chat.json", "rec", (j) => j, null],
  ["evidence/2790-s9f-host-parity/capture-results-chat.json", "res", (j) => j.results, (j) => j],
  ["evidence/2790-s9f-host-parity/capture-results.json", "res", (j) => j.reviewPage.results, (j) => j.reviewPage],
];
const digestOfUntouched = (arr) =>
  crypto
    .createHash("sha256")
    .update(arr.filter((r) => !CELLS.has(r.cell)).map((r) => `${r.cell}:${crypto.createHash("sha256").update(JSON.stringify(r)).digest("hex")}`).join("|"))
    .digest("hex");
const report = {};
for (const [file, kind, pick, envelope] of targets) {
  const atHead = JSON.parse(execFileSync("git", ["show", `${HEAD}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const headDigest = digestOfUntouched(pick(atHead));
  const raw = fs.readFileSync(file, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const j = JSON.parse(raw);
  const arr = pick(j);
  const beforeDigest = digestOfUntouched(arr);
  const spliced = [];
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr[i].cell;
    if (!CELLS.has(c)) continue;
    arr[i] = kind === "res" ? resByCell[c] : recByCell[c];
    spliced.push(c);
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
