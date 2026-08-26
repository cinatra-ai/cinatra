// ---------------------------------------------------------------------------
// cinatra#2790 S9f — THE SPLICE. Puts a capture run's records into the canonical
// index and the evidence twins, and NOTHING ELSE into them.
//
// It replaces, by cell name, exactly the cells the run produced; every other
// record in the index is left untouched, byte for byte, and the script reports
// the count and a digest of that untouched remainder so a reader can check it.
//
// The RESULTS ENVELOPE travels with its results: `wire` and `pageErrors` are
// properties of the capture EXECUTION rather than of a cell, so they are taken
// from the same run. Leaving the previous round's values beside re-shot results
// made the file describe two different runs at once — caught by a convergence
// review, fixed here.
//
// Usage: node 13-splice-records.mjs <runOutDir>   (run from the repo root)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import crypto from "node:crypto";
const SRC = process.argv[2];
const newRecs = JSON.parse(fs.readFileSync(SRC + "/capture-records.json", "utf8"));
const newRes = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8")).results;
const CELLS = new Set(newRecs.map((r) => r.cell));
const recByCell = Object.fromEntries(newRecs.map((r) => [r.cell, r]));
const resByCell = Object.fromEntries(newRes.map((r) => [r.cell, r]));
const targets = [
  ["scripts/ci/chat-hitl-capture-index.json", "rec", (j) => j.records],
  ["evidence/2790-s9f-host-parity/capture-records-rework.json", "rec", (j) => j],
  ["evidence/2790-s9f-host-parity/capture-records-r6.json", "rec", (j) => j],
  ["evidence/2790-s9f-host-parity/capture-results-rework.json", "res", (j) => j.results],
  ["evidence/2790-s9f-host-parity/capture-results-r6.json", "res", (j) => j.results],
];
const report = {};
for (const [file, kind, pick] of targets) {
  const raw = fs.readFileSync(file, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const j = JSON.parse(raw);
  const arr = pick(j);
  let spliced = [];
  const untouched = [];
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr[i].cell;
    if (CELLS.has(c)) {
      arr[i] = kind === "res" ? resByCell[c] : recByCell[c];
      spliced.push(c);
    } else {
      untouched.push(`${c}:${crypto.createHash("sha256").update(JSON.stringify(arr[i])).digest("hex")}`);
    }
  }
  // THE RESULTS ENVELOPE TRAVELS WITH ITS RESULTS. `wire` and `pageErrors` are
  // properties of the CAPTURE EXECUTION, not of a cell, so leaving the previous
  // round's values beside re-shot results makes the file describe two different
  // runs at once — which a convergence review caught. They are replaced from the
  // same execution the results came from.
  if (kind === "res") {
    j.wire = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8")).wire;
    j.pageErrors = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8")).pageErrors;
  }
  const out = JSON.stringify(j, null, 2) + (trailingNewline ? "\n" : "");
  fs.writeFileSync(file, out);
  report[file] = {
    spliced: spliced.length,
    splicedCells: spliced,
    untouchedCount: untouched.length,
    untouchedDigest: crypto.createHash("sha256").update(untouched.join("|")).digest("hex").slice(0, 16),
  };
}
console.log(JSON.stringify(report, null, 2));
