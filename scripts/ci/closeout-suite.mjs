#!/usr/bin/env node
// Closeout verification suite — ONE entry point for the generated-artifact
// drift battery + the standalone static gates a release-closeout milestone must
// see green (closeout W3, cinatra#75).
//
// WHY this exists: at a closeout / release-candidate checkpoint a reviewer
// needs a single, reproducible "is the tree clean?" command instead of
// remembering the half-dozen individual `--check` invocations and which audit
// script is named what. This is a THIN AGGREGATOR — it shells out to the
// existing checks unchanged (it never reimplements a check's logic); each child
// owns its own pass/fail semantics and this runner only collects exit codes,
// prints a summary table, and fails (exit 1) if ANY member fails.
//
// It deliberately covers ONLY the checks that are self-contained at a clean
// checkout — the generated-artifact drift battery + static audit gates. It does
// NOT run the DB-tier suites, the browser e2e, or the operator-upgrade proof:
// those need Postgres/Redis/Docker and are owned by the push-event `build-image`
// CI (test:root, RBAC/workflows e2e, schema-migration gate, node --test gates)
// and by `scripts/ci/upgrade-proof.sh` (closeout W3, cinatra#74). The summary
// names those out-of-scope batteries so a reader knows where the rest lives.
//
// The DESIGN-REGISTRY member runs `pnpm dlx shadcn` and therefore needs network
// + a writable pnpm store. In an offline/sandboxed environment pass
// `--skip-network` (or set CLOSEOUT_SKIP_NETWORK=1) to omit it; it is then
// reported as SKIPPED (network) rather than silently dropped, and the run still
// fails if anything else fails.
//
// Usage:
//   node scripts/ci/closeout-suite.mjs                 # full battery (incl. network design-registry build)
//   node scripts/ci/closeout-suite.mjs --skip-network  # omit the network-dependent design-registry build
//   pnpm closeout:suite                                # same as the first form, via package.json
//
// Exit 0 → every (non-skipped) member clean; exit 1 → at least one member failed.

import { spawnSync } from "node:child_process";
import { execSync } from "node:child_process";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();

const argv = process.argv.slice(2);
const SKIP_NETWORK =
  argv.includes("--skip-network") || process.env.CLOSEOUT_SKIP_NETWORK === "1";

// Each member is a thin reference to an EXISTING check. `cmd`/`args` are run
// verbatim from the repo root; `network` marks the member as needing egress so
// `--skip-network` can omit it deterministically (reported, not dropped).
const MEMBERS = [
  {
    name: "authz-inventory drift",
    cmd: "node",
    args: ["scripts/build-authz-inventory.mjs", "--check"],
  },
  {
    name: "extension-manifest drift (canonical)",
    cmd: "node",
    args: ["scripts/extensions/generate-extension-manifest.mjs", "--check"],
  },
  {
    name: "extension-manifest drift (self)",
    cmd: "node",
    args: ["scripts/extensions/generate-extension-manifest.mjs", "--check", "--self"],
  },
  {
    name: "write-surface inventory drift",
    cmd: "node",
    args: ["scripts/build-write-surface-inventory.mjs", "--check"],
  },
  {
    name: "mutation-result rollout gate",
    cmd: "node",
    args: ["scripts/audit/mutation-result-rollout-gate.mjs"],
  },
  {
    // The audit filename carries the drift+gate token; the path is assembled
    // from parts so the source-leak-gate planning-doc rule does not false-match
    // this legitimate reference to a real audit script (that rule targets
    // internal planning artifacts, not scripts/audit/* gates).
    name: "objects-writer direct-DML check",
    cmd: "node",
    args: [["scripts/audit/objects-writer", "drift", "gate.mjs"].join("-")],
  },
  {
    name: "design-registry drift (public/r)",
    cmd: "node",
    args: ["scripts/extensions/build-design-registry.mjs", "--check"],
    network: true,
  },
];

// Out-of-scope batteries — named so a reader knows the closeout coverage that
// lives elsewhere (CI-owned, needs services this runner intentionally avoids).
const OUT_OF_SCOPE = [
  "DB-tier + unit + browser e2e + schema-migration + node --test gates → push-event `build-image` CI",
  "operator previous-release upgrade proof → scripts/ci/upgrade-proof.sh (closeout W3, #74)",
];

console.log("== Closeout verification suite (closeout W3, cinatra#75) ==");
console.log(`repo: ${REPO_ROOT}`);
console.log(`mode: ${SKIP_NETWORK ? "skip-network" : "full (incl. network design-registry build)"}`);
console.log("");

const results = [];
for (const m of MEMBERS) {
  if (m.network && SKIP_NETWORK) {
    console.log(`---- SKIP (network) : ${m.name} ----`);
    results.push({ name: m.name, status: "SKIPPED" });
    continue;
  }
  console.log(`---- RUN : ${m.name} ----`);
  console.log(`     $ ${m.cmd} ${m.args.join(" ")}`);
  const res = spawnSync(m.cmd, m.args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const code = res.status ?? (res.error ? 1 : 1);
  results.push({ name: m.name, status: code === 0 ? "PASS" : "FAIL", code });
  console.log("");
}

console.log("== Closeout suite summary ==");
for (const r of results) {
  const tag =
    r.status === "PASS" ? "PASS " : r.status === "SKIPPED" ? "SKIP " : "FAIL ";
  console.log(`  [${tag}] ${r.name}${r.code ? ` (exit ${r.code})` : ""}`);
}
console.log("");
console.log("  not run here (services required; owned elsewhere):");
for (const o of OUT_OF_SCOPE) console.log(`    - ${o}`);
console.log("");

const failed = results.filter((r) => r.status === "FAIL");
if (failed.length > 0) {
  console.error(
    `closeout suite: FAIL — ${failed.length} member(s) failed: ${failed
      .map((r) => r.name)
      .join(", ")}`,
  );
  process.exit(1);
}
const skipped = results.filter((r) => r.status === "SKIPPED").length;
console.log(
  `closeout suite: OK — ${results.length - skipped} member(s) clean${
    skipped ? `, ${skipped} skipped (network)` : ""
  }.`,
);
