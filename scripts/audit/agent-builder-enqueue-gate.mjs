#!/usr/bin/env node
// CI gate enforcing the `enqueueAgentRun` chokepoint.
//
// Bans the dual pattern (`BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION` and
// raw string `"AGENT_BUILDER_EXECUTION"`) in any `.ts/.tsx/.mjs` file under
// `src/` or `packages/` outside the explicit 6-file allowlist:
//   1. src/lib/agent-run-enqueue.ts           — the chokepoint itself
//   2. src/lib/background-jobs.ts             — BullMQ worker runtime (consumer)
//   3. src/lib/background-jobs-registry.ts    — BullMQ worker dispatcher/registry
//                                               (consumer; cinatra#304 moved the
//                                               handler table here)
//   4. packages/agents/src/orchestrator-execution.ts — cancel-only callback
//   5. packages/agents/src/review-task-actions.ts    — same-run re-enqueue
//   6. packages/agents/src/execution.ts       — setup-loop same-run re-enqueue
//
// Exit non-zero on first violation. Intended to run from CI + as a pre-merge
// gate. Single-line comment lines (`// ...`) are skipped to avoid false
// positives on documentation; block comments and JSDoc are scanned.
//
// Usage: `node scripts/audit/agent-builder-enqueue-gate.mjs`
//        exit 0 → clean
//        exit 1 → at least one violation, lines printed to stderr.

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  encoding: "utf8",
}).trim();

const ALLOWLIST = new Set([
  "src/lib/agent-run-enqueue.ts",
  "src/lib/background-jobs.ts",
  "src/lib/background-jobs-registry.ts",
  "packages/agents/src/orchestrator-execution.ts",
  "packages/agents/src/review-task-actions.ts",
  "packages/agents/src/execution.ts",
  // Self-allowlist — the script defines the banned patterns and must
  // mention them by name; otherwise the gate would always self-fail.
  "scripts/audit/agent-builder-enqueue-gate.mjs",
]);

const PATTERNS = [
  // Pattern A — symbolic reference via the BackgroundJobName enum.
  {
    label: "BACKGROUND_JOB_NAMES.AGENT_BUILDER_EXECUTION",
    re: /BACKGROUND_JOB_NAMES\s*\.\s*AGENT_BUILDER_EXECUTION/,
  },
  // Pattern B — raw literal. Tests can still smuggle the literal in via
  // string concatenation if they really need to; the gate intentionally
  // surfaces the direct literal because that is the pattern review forgot.
  {
    label: '"AGENT_BUILDER_EXECUTION"',
    re: /["']AGENT_BUILDER_EXECUTION["']/,
  },
];

async function collectFiles() {
  const out = execSync(
    "git ls-files src packages '*.ts' '*.tsx' '*.mjs'",
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .filter((p) => /\.(ts|tsx|mjs)$/.test(p))
    .filter((p) => !p.includes("/__tests__/")) // tests can carry the literal
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx") && !p.endsWith(".test.mjs"));
}

function isLineComment(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

async function main() {
  const files = await collectFiles();
  const violations = [];
  for (const rel of files) {
    if (ALLOWLIST.has(rel)) continue;
    const content = await readFile(resolve(REPO_ROOT, rel), "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isLineComment(line)) continue;
      for (const { label, re } of PATTERNS) {
        if (re.test(line)) {
          violations.push({ file: rel, line: i + 1, label, text: line.trim() });
        }
      }
    }
  }
  if (violations.length === 0) {
    console.log(
      `[agent-builder-enqueue-gate] OK — ${files.length} files scanned, 0 violations`,
    );
    process.exit(0);
  }
  console.error(
    `[agent-builder-enqueue-gate] FAIL — ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.label}] → ${v.text}`);
  }
  console.error(
    "\nAll agent-run enqueues must go through `enqueueAgentRun()` " +
      "in `src/lib/agent-run-enqueue.ts`. " +
      "The 5-file allowlist is documented at the top of this script.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(`[agent-builder-enqueue-gate] crashed: ${err.message}`);
  process.exit(2);
});
