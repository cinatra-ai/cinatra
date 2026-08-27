// REGISTER THIS ROUND'S RECORDS IN THE CANONICAL INDEX, through the SHIPPED
// merge.
//
// The walk was driven with `--out` pointing at this evidence directory's own
// `capture-records.json`, because a walk is driven in more than one pass — the
// run's clock is real — and a half-finished pass must never be able to leave the
// canonical index in a state no single run produced. This driver moves the
// finished set across with `mergeWalkRecords`, the SAME function the driver's
// own `--out` path uses, so a record registered here is byte-identical to one the
// driver would have written straight into the index: each rewritten cell is
// replaced WHERE IT STANDS, and every record this round did not write is left
// untouched and in place.
//
// It writes nothing if the shipped validator refuses the result.
//
//   env: RECORDS_IN, INDEX_PATH (default the canonical index)
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  mergeWalkRecords,
  validateCaptureIndex,
  hashFile,
} from "../../../scripts/audit/lib/chat-hitl-capture-recorder.mjs";

const INDEX = process.env.INDEX_PATH ?? "scripts/ci/chat-hitl-capture-index.json";
const IN = process.env.RECORDS_IN;
if (!IN) throw new Error("the register driver needs RECORDS_IN");

const index = JSON.parse(readFileSync(resolve(INDEX), "utf8"));
const lane = JSON.parse(readFileSync(resolve(IN), "utf8"));
const before = (index.records ?? []).length;
const merged = mergeWalkRecords({ index, records: lane.records ?? [], retires: lane.retires ?? [] });
const violations = validateCaptureIndex({
  index: merged,
  hashOf: (rel) => hashFile(join(process.cwd(), rel)),
  tier: "graded",
});
if (violations.length > 0) {
  for (const v of violations) console.error(`  ${v}`);
  throw new Error(`the merged index would be refused (${violations.length} violation(s)) — nothing written`);
}
writeFileSync(resolve(INDEX), `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `registered ${(lane.records ?? []).length} record(s): ${before} -> ${merged.records.length}; ` +
    `the shipped validator accepts all ${merged.records.length}`,
);
