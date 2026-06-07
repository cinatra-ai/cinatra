#!/usr/bin/env node
/**
 * `/agents/status` route-retirement guard.
 *
 * The standalone agent-list table at `/agents/status` is retired. `/agents` (the
 * drizzle-cube dashboard) is now the single installed-agents surface, and the
 * `[vendor]/[packageName]/[instanceId]` instance routes own the live run
 * pages. This gate prevents the legacy `/agents/status` path from being
 * reintroduced as a current page reference.
 *
 * Scoped to tracked first-party TypeScript / JS / Markdown / YAML under
 * `src/`, `packages/`, `docs/`, `scripts/`, `.github/`, and the top-level
 * `README.md` (YAML included so a CI-workflow reintroduction is caught). The
 * audit script self-reference + its test are excluded.
 *
 * Touch-ratchet via `AGENTS_STATUS_ROUTE_DIFF_BASE`: a finding on a line a PR
 * DID NOT add is tolerated (pre-existing legacy); a finding on a line a PR
 * ADDED blocks. This mirrors the no-new-rot touch-ratchet pattern
 * and the shared helper `scripts/audit/_lib/touch-ratchet.mjs`.
 *
 * Exit codes:
 *   0  no NEW `/agents/status` references introduced by this PR
 *   1  one or more NEW `/agents/status` references introduced by this PR
 *   2  `AGENTS_STATUS_ROUTE_DIFF_BASE` set but does not resolve to a git ref
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
  "scripts/audit/agents-status-route-banned.mjs",
  "scripts/audit/__tests__/agents-status-route-banned.test.mjs",
]);

// Matches the route literal in any string / href / Link / redirect position,
// including the `/agents/status/<runId>` run-page rot — both are retired.
// Negative lookahead rejects a longer segment (`/agents/statusboard`) while
// allowing path continuation (`/agents/status/<runId>`), punctuation, quotes,
// and end-of-line.
const BANNED_PATTERN = /\/agents\/status(?![\w-])/g;

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

/** Collect 1-indexed line numbers where the banned pattern matches. */
export function scanFile(content) {
  const hits = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    BANNED_PATTERN.lastIndex = 0;
    if (BANNED_PATTERN.test(lines[i])) hits.push(i + 1);
  }
  return hits;
}

function main() {
  let baseRef;
  try {
    baseRef = resolveBaseRef("AGENTS_STATUS_ROUTE_DIFF_BASE");
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
    const hitLines = scanFile(content);
    if (hitLines.length === 0) continue;

    const addedLines = baseRef
      ? getAddedLineNumbers(file, baseRef, renameMap)
      : null;
    if (addedLines === null) {
      // genuinely new at base, or strict mode → every hit is introduced
      findings.push({ file, lines: hitLines });
      continue;
    }
    const introduced = hitLines.filter((ln) => addedLines.has(ln));
    if (introduced.length > 0) {
      findings.push({ file, lines: introduced });
    } else {
      toleratedFileCount += 1;
    }
  }

  if (findings.length === 0) {
    if (toleratedFileCount > 0) {
      console.log(
        `✓ no NEW /agents/status references introduced by this PR ` +
          `(${toleratedFileCount} legacy file(s) still carrying refs — tolerated).`,
      );
    } else {
      console.log("✓ no /agents/status references found.");
    }
    return;
  }

  console.error(
    "ERROR: the /agents/status route was retired —\n" +
      "NEW references introduced by this PR were found:\n",
  );
  for (const { file, lines } of findings) {
    console.error(`  ${file} — line(s) ${lines.join(", ")}`);
  }
  console.error(
    "\nThe /agents dashboard is the single installed-agents surface; live run\n" +
      "pages are the [vendor]/[packageName]/[instanceId] instance routes. Do not\n" +
      "reintroduce /agents/status.",
  );
  process.exit(1);
}

main();
