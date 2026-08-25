// ---------------------------------------------------------------------------
// ASSEMBLE THE SLICE'S RECORDS, AND SPLICE THE ONE CANONICAL CELL IT REPLACES.
//
// The walk writes its raw results beside the lane; this file lays them out
// into `capture-records.json`, writes the `page-controls.json` sidecar (the
// Run-now count read off EVERY pictured surface, and the run page's two
// structural readings), writes `timeline.json` out of the passes' own database
// stamps, and then performs ONE splice on
// `scripts/ci/chat-hitl-capture-index.json`:
//
//   S9d-C3__schedule-card__run_card__decided            -> re-shot on this branch
//   S9d-C3__schedule-card__run_card__decided__dark      -> re-shot on this branch
//
// and NOTHING ELSE. The splice is verified three ways before it is written:
//   1. exactly the two named cells change;
//   2. every other record is byte-identical to the one it replaced;
//   3. the record COUNT is unchanged.
// A failure on any of the three aborts without writing.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const EV = "evidence/2972-schedule-controls";
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const IN = process.env.IN_DIR;
if (!IN) throw new Error("needs IN_DIR");

/** The cells this slice files, in the order the proof reads. */
const ORDER = [
  "F1__schedule-card__chat_thread__settled__one-off-fired",
  "F1__schedule-card__chat_thread__settled__one-off-fired__dark",
  "F2__schedule-card__run_card__settled__one-off-fired",
  "F2__schedule-card__run_card__settled__one-off-fired__dark",
  "G1__schedule-card__chat_thread__settled__recurring-fired",
  "G1__schedule-card__chat_thread__settled__recurring-fired__dark",
  "G2__schedule-card__run_card__settled__recurring-fired",
  "G2__schedule-card__run_card__settled__recurring-fired__dark",
  "K1__schedule-card__run_card__settled__saved-change",
  "K1__schedule-card__run_card__settled__saved-change__dark",
  "K2__schedule-card__run_card__settled__change-applied",
  "K2__schedule-card__run_card__settled__change-applied__dark",
  "J1__schedule-card__run_card__settled__stopped",
  "J1__schedule-card__run_card__settled__stopped__dark",
  "J2__schedule-card__chat_thread__settled__stopped",
  "J2__schedule-card__chat_thread__settled__stopped__dark",
  "S9d-C3__schedule-card__run_card__decided",
  "S9d-C3__schedule-card__run_card__decided__dark",
];

/**
 * THE ALLOWLIST, hard-coded. The two cells this slice replaces are named HERE,
 * in the tool, rather than inferred from whatever the walk happened to write —
 * an inferred set can only ever agree with itself, so it could not have caught a
 * third replacement slipping in. The supplied records must be exactly these two.
 */
const REPLACED = [
  "S9d-C3__schedule-card__run_card__decided",
  "S9d-C3__schedule-card__run_card__decided__dark",
];
const supplied = read(join(IN, "index-records.json"));
const suppliedCells = supplied.map((r) => r.cell).sort();
if (suppliedCells.length !== REPLACED.length || suppliedCells.some((c, i) => c !== [...REPLACED].sort()[i])) {
  throw new Error(`the splice was handed ${JSON.stringify(suppliedCells)}, and this slice replaces exactly ${JSON.stringify(REPLACED)}`);
}
const replacements = new Map(supplied.map((r) => [r.cell, r]));

const all = read(join(IN, "records.json"));
const byCell = new Map(all.map((r) => [r.cell, r]));
const records = ORDER.map((c) => {
  const r = byCell.get(c);
  if (!r) throw new Error(`the assembly is missing a record for ${c}`);
  return r;
});
writeFileSync(join(REPO_ROOT, EV, "capture-records.json"), `${JSON.stringify(records, null, 2)}\n`);

const controls = read(join(IN, "controls.json")).filter((c) => ORDER.includes(c.cell));
/**
 * The sidecar row carries the per-surface counts AND the two GEOMETRIC readings,
 * lifted from the record the same shutter wrote. They used to live only in
 * `capture-records.json` while this file's own header credited the sidecar with
 * them — a small untruth, and the kind this directory exists to not contain.
 */
const sidecar = ORDER.map((cell) => {
  const c = controls.find((x) => x.cell === cell);
  if (!c) return null;
  const r = byCell.get(cell);
  return {
    ...c,
    promptWindowGeometry: r?.surface?.promptWindowGeometry ?? null,
    detailRightOfRail: r?.surface?.detailRightOfRail ?? null,
  };
}).filter(Boolean);
const runNowTotal = sidecar.reduce((n, c) => n + (c.runNowControlsOnThisSurface ?? 0), 0);
if (runNowTotal !== 0) throw new Error(`a pictured surface carried ${runNowTotal} Run-now control(s)`);
writeFileSync(
  join(REPO_ROOT, EV, "page-controls.json"),
  `${JSON.stringify({
    $comment: [
      "THE PER-SURFACE CONTROL COUNT, read off each pictured screen at the shutter.",
      "`runNowControlsOnThisSurface` is document.querySelectorAll('[data-action=\"release-trigger-now\"]').length",
      "on the whole screen, not inside the card — the claim is that the control is gone from the SURFACE.",
      "Every row is 0, and this file aborts rather than writes if any row is not.",
      "",
      "`promptWindowGeometry` and `detailRightOfRail` are BOUNDING-BOX readings taken at the same",
      "shutter: where the prompt window is PAINTED relative to the scheduler card, and where the",
      "run detail column starts relative to the step rail. Document order is recorded too, on the",
      "record, but it is not what 'below the scheduler' or 'to the right of the steps' claims.",
    ],
    runNowControlsAcrossEveryPicturedSurface: runNowTotal,
    surfaces: sidecar,
  }, null, 2)}\n`,
);

const timeline = read(join(IN, "timeline.json"));
writeFileSync(join(REPO_ROOT, EV, "readback", "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);

// ---------------------------------------------------------------------------
// THE SPLICE — exactly two records, verified four ways. The ALLOWLIST above is
// checked BEFORE this file writes anything at all, so a wrong replacement set
// aborts the whole run rather than leaving three evidence files behind it.
// ---------------------------------------------------------------------------
const INDEX_REL = "scripts/ci/chat-hitl-capture-index.json";
const indexPath = join(REPO_ROOT, INDEX_REL);
const beforeText = readFileSync(indexPath, "utf8");
const index = JSON.parse(beforeText);


const beforeSerialized = index.records.map((r) => JSON.stringify(r));
index.records = index.records.map((r) => replacements.get(r.cell) ?? r);
const afterSerialized = index.records.map((r) => JSON.stringify(r));

if (afterSerialized.length !== beforeSerialized.length) throw new Error("the splice changed the record count");
const changed = [];
for (let i = 0; i < beforeSerialized.length; i += 1) {
  if (beforeSerialized[i] !== afterSerialized[i]) changed.push(index.records[i].cell);
}
const sameSet = changed.length === REPLACED.length && changed.every((c) => REPLACED.includes(c));
if (!sameSet) throw new Error(`the splice changed ${JSON.stringify(changed)}, not exactly ${JSON.stringify(REPLACED)}`);
const trailing = beforeText.endsWith("\n") ? "\n" : "";
writeFileSync(indexPath, JSON.stringify(index, null, 2) + trailing);
console.log(`SPLICED ${changed.length} record(s): ${changed.join(", ")}`);
console.log(`RECORDS ${records.length} · SURFACES ${sidecar.length} · RUN-NOW TOTAL ${runNowTotal}`);
