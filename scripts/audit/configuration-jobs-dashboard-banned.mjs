#!/usr/bin/env node
/**
 * Configuration jobs-dashboard route-retirement guard.
 *
 * The QueueDash-backed Environment "jobs" tab and its dedicated route at
 * `/configuration/environment/jobs-dashboard` have been retired.
 * The BullMQ board has no other UI route today;
 * if a successor surface is wanted, it must be wired into a fresh route via
 * `cinatra.devExtensions` + an explicit allowlist entry here.
 *
 * Bans:
 *   - the literal path `/configuration/environment/jobs-dashboard`
 *   - the literal env-tab string `?tab=jobs` scoped to /configuration/environment
 *   - the removed plumbing symbols (`JobsDashboardFrame`, `JobsTabContent`)
 *
 * Scoped to tracked first-party TS / JS / Markdown / YAML under `src/`,
 * `packages/`, `docs/`, `scripts/`, `.github/`, and the top-level `README.md`.
 * The audit script self-reference + its test are excluded.
 *
 * Touch-ratchet via `JOBS_DASHBOARD_DIFF_BASE`.
 *
 * Exit codes:
 *   0  no NEW jobs-dashboard references introduced by this PR
 *   1  one or more NEW jobs-dashboard references introduced by this PR
 *   2  `JOBS_DASHBOARD_DIFF_BASE` set but does not resolve to a git ref
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  resolveBaseRef,
  buildRenameMap,
  getAddedLineNumbers,
} from "./_lib/touch-ratchet.mjs";

const SCAN_PREFIXES = ["src/", "packages/", "docs/", "scripts/", ".github/", "README.md"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/configuration-jobs-dashboard-banned.mjs",
  "scripts/audit/__tests__/configuration-jobs-dashboard-banned.test.mjs",
]);

// Each pattern is anchored / scoped tight enough that the package
// `@cinatra-ai/background-jobs` and the generic word "jobs" do not match.
const BANNED_PATTERNS = [
  {
    re: /\/configuration\/environment\/jobs-dashboard(?![\w-])/g,
    label: "retired /configuration/environment/jobs-dashboard route literal",
  },
  {
    re: /\/configuration\/environment\?tab=jobs(?![\w-])/g,
    label: "retired Environment ?tab=jobs link",
  },
  { re: /\bJobsDashboardFrame\b/g, label: "removed JobsDashboardFrame symbol" },
  { re: /\bJobsTabContent\b/g, label: "removed JobsTabContent symbol" },
];

function listTrackedFiles() {
  const out = execFileSync("git", ["ls-files", "--", ...SCAN_PREFIXES], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => /\.(ts|tsx|mjs|cjs|js|jsx|md|ya?ml)$/.test(p))
    .filter((p) => !ALLOWLIST_PATHS.has(p));
}

/** Collect 1-indexed line numbers + the matched pattern label per hit. */
export function scanFile(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const { re, label } of BANNED_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(lines[i])) hits.push({ line: i + 1, label });
    }
  }
  return hits;
}

function main() {
  let baseRef;
  try {
    baseRef = resolveBaseRef("JOBS_DASHBOARD_DIFF_BASE");
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
  const renameMap = buildRenameMap(baseRef);

  const findings = [];
  let toleratedFileCount = 0;
  for (const file of listTrackedFiles()) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hits = scanFile(content);
    if (hits.length === 0) continue;

    const addedLines = baseRef
      ? getAddedLineNumbers(file, baseRef, renameMap)
      : null;
    if (addedLines === null) {
      findings.push({ file, hits });
      continue;
    }
    const introduced = hits.filter((h) => addedLines.has(h.line));
    if (introduced.length > 0) {
      findings.push({ file, hits: introduced });
    } else {
      toleratedFileCount += 1;
    }
  }

  if (findings.length === 0) {
    if (toleratedFileCount > 0) {
      console.log(
        `✓ no NEW jobs-dashboard references introduced by this PR ` +
          `(${toleratedFileCount} legacy file(s) still carrying refs — tolerated).`,
      );
    } else {
      console.log("✓ no jobs-dashboard references found.");
    }
    return;
  }

  console.error(
    "ERROR: the Environment jobs-dashboard surface was retired —\n" +
      "NEW references introduced by this PR were found:\n",
  );
  for (const { file, hits } of findings) {
    console.error(`  ${file}`);
    for (const { line, label } of hits) {
      console.error(`    L${line}: ${label}`);
    }
  }
  console.error(
    "\nThe BullMQ board has no UI route today. If you need a successor, create\n" +
      "it under a different route via cinatra.devExtensions and add the path to\n" +
      "this gate's allowlist with a recorded reason.",
  );
  process.exit(1);
}

main();
