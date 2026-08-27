// ---------------------------------------------------------------------------
// cinatra#2790 S9f — the splice for the WIDGET round's seven cells.
//
// It replaces, BY CELL NAME, exactly the seven site_widget recommendation cells
// this round re-shot from a real widget-started run, and nothing else. Every
// other record is left byte-identical, and the count plus a digest of that
// untouched remainder is reported so a reader can check that claim rather than
// take it.
//
// Usage: node 26-splice-widget-records.mjs <runOutDir>   (from the repo root)
// ---------------------------------------------------------------------------
import fs from "node:fs";
import crypto from "node:crypto";
const SRC = process.argv[2];
const newRecs = JSON.parse(fs.readFileSync(SRC + "/capture-records.json", "utf8"));
const newRes = JSON.parse(fs.readFileSync(SRC + "/capture-results.json", "utf8"));
const wire = JSON.parse(fs.readFileSync(SRC + "/widget-wire.json", "utf8"));
const state = JSON.parse(fs.readFileSync(SRC + "/state.json", "utf8"));
const CELLS = new Set(newRecs.map((r) => r.cell));

// THE TWO RECORD SHAPES, kept exactly as the tree already keeps them.
//   canonical — `scripts/ci/chat-hitl-capture-index.json` carries the LEAN
//               record the shipped recorder validates: the thirteen fields and
//               nothing else, with `declaredState` in the contract's own
//               vocabulary (`pending` / `decided`, `STATE_ALIASES` in
//               scripts/ci/lib/capture-record-contract.mjs). A round that
//               widened it would be changing the index's schema, not recording
//               a cell.
//   twin      — the evidence twin keeps the round's full readings beside each
//               cell (the root's own attributes, every chip, the palette class,
//               the framing) because that is what a reader grades against §V.
const CANONICAL_FIELDS = [
  "cell", "declaredHost", "declaredKind", "declaredState", "finalUrl", "frameUrl",
  "screenshot", "sha256", "assertions", "recordedBy", "recordedAt", "runtime", "note",
];
const STATE_FOR_INDEX = { held: "pending", pending: "pending", settled: "decided", decided: "decided" };
const normalize = (r) => ({ ...r, declaredState: STATE_FOR_INDEX[r.declaredState] ?? r.declaredState });
const lean = (r) => Object.fromEntries(CANONICAL_FIELDS.map((k) => [k, normalize(r)[k]]));
const canonicalByCell = Object.fromEntries(newRecs.map((r) => [r.cell, lean(r)]));
const twinByCell = Object.fromEntries(newRecs.map((r) => [r.cell, normalize(r)]));

const report = {};
for (const [file, pick, shape] of [
  ["scripts/ci/chat-hitl-capture-index.json", (j) => j.records, canonicalByCell],
  ["evidence/2790-s9f-host-parity/capture-records.json", (j) => j, twinByCell],
]) {
  const raw = fs.readFileSync(file, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const j = JSON.parse(raw);
  const arr = pick(j);
  const spliced = [];
  const untouched = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i += 1) {
    const c = arr[i].cell;
    if (CELLS.has(c)) { arr[i] = shape[c]; spliced.push(c); seen.add(c); }
    else untouched.push(`${c}:${crypto.createHash("sha256").update(JSON.stringify(arr[i])).digest("hex")}`);
  }
  const missing = [...CELLS].filter((c) => !seen.has(c));
  if (missing.length) throw new Error(`cells not present in ${file}: ${missing.join(", ")}`);
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + (trailingNewline ? "\n" : ""));
  report[file] = {
    spliced: spliced.length,
    splicedCells: spliced,
    untouchedCount: untouched.length,
    untouchedDigest: crypto.createHash("sha256").update(untouched.join("|")).digest("hex").slice(0, 16),
  };
}

// The RESULTS ENVELOPE travels with its results: the widget half of the results
// twin is replaced from the SAME execution the records came from, so the file
// never describes two runs at once.
{
  const file = "evidence/2790-s9f-host-parity/capture-results.json";
  const raw = fs.readFileSync(file, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const j = JSON.parse(raw);
  const before = Object.keys(j);
  j.siteWidget = {
    $comment:
      "The widget's seven recommendation cells, re-shot 2026-08-27 from a run STARTED INSIDE THE WIDGET by the person's own turn through the #2996 named-agent start. Nothing is seeded: the run, the park and the decision were all written by the app's own dispatch.",
    run: state.run ?? null,
    park: state.park ?? null,
    prompt: state.prompt ?? null,
    turnSentAt: state.turnSentAt ?? null,
    statusBefore: state.statusBefore ?? null,
    statusAfter: state.statusAfter ?? null,
    settledInPlace: state.settledInPlace ?? null,
    inFlightMs: state.inFlightMs ?? null,
    themeToDark: state.themeToDark ?? null,
    themeToLight: state.themeToLight ?? null,
    results: newRes,
    wire: wire.wire,
    wireResponses: wire.wireResponses,
    decideOutcomes: wire.decideOutcomes,
  };
  if (before.join(",") !== Object.keys(j).join(",")) throw new Error("results twin gained or lost a top-level key");
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + (trailingNewline ? "\n" : ""));
  report[file] = { replaced: "siteWidget", cells: newRes.length };
}
console.log(JSON.stringify(report, null, 2));
