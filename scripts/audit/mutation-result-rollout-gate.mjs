#!/usr/bin/env node
// MutationResult rollout gate.
//
// The "rollout complete" merge guard. Two checks:
//   1. The write-surface inventory is fresh + every write action is classified
//      (delegates to build-write-surface-inventory.mjs --check). A NEW
//      unclassified object-write server action fails CI until it is added to
//      the inventory as MIGRATED / PENDING / EXCLUDED (with a reason).
//   2. Regression guard: every MIGRATED surface's file still imports
//      MutationResult — a migrated action cannot silently drop the contract.
//
// PENDING rows are allowed + tracked (rails-first; the
// redirect-form CRUD migrations ride per-area follow-up PRs with browser UAT).
// This gate keeps that boundary honest — never silent debt.
//
// Exit 0 → clean; exit 1 → violation.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

// 1. Inventory freshness + classification completeness.
try {
  execSync("node scripts/build-write-surface-inventory.mjs --check", {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}

// 2. MIGRATED-surface regression guard.
const inventory = JSON.parse(
  readFileSync(
    resolve(REPO_ROOT, "src/lib/object-history/__generated__/write-surface-inventory.json"),
    "utf8",
  ),
);
const regressions = [];
for (const s of inventory.surfaces) {
  if (s.status !== "MIGRATED") continue;
  const src = readFileSync(resolve(REPO_ROOT, s.file), "utf8");
  if (!src.includes("MutationResult")) {
    regressions.push(`${s.file}::${s.action} is MIGRATED but no longer references MutationResult`);
  }
}
if (regressions.length > 0) {
  console.error(
    "mutation-result rollout gate: MIGRATED surface(s) regressed:\n" +
      regressions.map((r) => `  - ${r}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `mutation-result rollout gate: OK (${JSON.stringify(inventory.tally)}).`,
);
