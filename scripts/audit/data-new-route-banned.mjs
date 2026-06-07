#!/usr/bin/env node
/**
 * `/data/new` route-retirement guard.
 *
 * The standalone "New data item" type-chooser at `/data/new` has been retired.
 * The per-type creation routes it linked to are unaffected; `/data/types`
 * remains the type browse + creation entry point. This gate prevents the legacy
 * `/data/new` path from being reintroduced.
 *
 * Scoped to tracked first-party TypeScript / JS / Markdown / YAML under
 * `src/`, `packages/`, `docs/`, `scripts/`, `.github/`, and the top-level
 * `README.md`. The audit script self-reference + its test are excluded.
 *
 * Touch-ratchet via `DATA_NEW_ROUTE_DIFF_BASE`: a finding on a line a PR DID
 * NOT add is tolerated; a finding on a line a PR ADDED blocks. Mirrors
 * `scripts/audit/_lib/touch-ratchet.mjs`.
 *
 * Exit codes:
 *   0  no NEW `/data/new` references introduced by this PR
 *   1  one or more NEW `/data/new` references introduced by this PR
 *   2  `DATA_NEW_ROUTE_DIFF_BASE` set but does not resolve to a git ref
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
  "scripts/audit/data-new-route-banned.mjs",
  "scripts/audit/__tests__/data-new-route-banned.test.mjs",
]);

// Negative lookahead rejects a longer segment (`/data/newsletter`) while
// allowing path continuation (`/data/new/<id>`), punctuation, quotes, and
// end-of-line.
const BANNED_PATTERN = /\/data\/new(?![\w-])/g;

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
    baseRef = resolveBaseRef("DATA_NEW_ROUTE_DIFF_BASE");
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
        `✓ no NEW /data/new references introduced by this PR ` +
          `(${toleratedFileCount} legacy file(s) still carrying refs — tolerated).`,
      );
    } else {
      console.log("✓ no /data/new references found.");
    }
    return;
  }

  console.error(
    "ERROR: the /data/new route was retired —\n" +
      "NEW references introduced by this PR were found:\n",
  );
  for (const { file, lines } of findings) {
    console.error(`  ${file} — line(s) ${lines.join(", ")}`);
  }
  console.error(
    "\n/data/types is the type browse + creation entry point; per-type\n" +
      "creation routes are unaffected. Do not reintroduce /data/new.",
  );
  process.exit(1);
}

main();
