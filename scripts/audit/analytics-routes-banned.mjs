#!/usr/bin/env node
/**
 * Analytics route-rename guard.
 *
 * Three analytics app routes were renamed:
 *   /analytics/metric-cost-api  → /analytics/llm        ("API Costs"   → "LLM Costs")
 *   /analytics/metric-usage-api → /analytics/llm-usage  ("Token Usage" → "LLM Usage")
 *   /analytics/traces           → /analytics/api        ("Traces"      → "API Requests")
 *
 * Permanent 308 redirects in next.config.ts preserve external bookmarks.
 * This gate prevents new in-tree references to the old route literals so a
 * fresh writer cannot silently route through the redirect chain.
 *
 * Anchor: every matched literal is preceded by "/analytics/" so the gate does
 * NOT match the underlying package specifiers (`@cinatra-ai/metric-cost-api`,
 * `@cinatra-ai/metric-usage-api`) or the MCP primitive names
 * (`metric_cost_*`, `metric_usage_*`) — those are intentionally stable
 * and must keep working.
 *
 * Carved out:
 *   - the gate script + its test (ALLOWLIST_PATHS)
 *   - the bounded redirect region in `next.config.ts`
 *     (markers `analytics-routes-retire-allowlist-start/-end`)
 *
 * Touch-ratchet via `ANALYTICS_ROUTES_DIFF_BASE`: a finding on a line a PR
 * DID NOT add is tolerated; a finding on a line a PR ADDED blocks.
 *
 * Exit codes:
 *   0  no NEW old-route references introduced by this PR
 *   1  one or more NEW old-route references introduced by this PR
 *   2  `ANALYTICS_ROUTES_DIFF_BASE` set but does not resolve to a git ref
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  resolveBaseRef,
  buildRenameMap,
  getAddedLineNumbers,
} from "./_lib/touch-ratchet.mjs";

const SCAN_PREFIXES = ["src/", "packages/", "docs/", "scripts/", ".github/", "README.md", "next.config.ts"];

const ALLOWLIST_PATHS = new Set([
  "scripts/audit/analytics-routes-banned.mjs",
  "scripts/audit/__tests__/analytics-routes-banned.test.mjs",
]);

// Anchored on "/analytics/" so package specifiers and primitive names never
// match. Negative lookahead rejects longer segments like
// "/analytics/metric-cost-api-archive" while allowing path continuation,
// punctuation, quotes, and end-of-line.
const BANNED_PATTERN =
  /\/analytics\/(?:metric-cost-api|metric-usage-api|traces)(?![\w-])/g;

const NEXT_CONFIG_PATH = "next.config.ts";
const NEXT_CONFIG_ALLOWLIST_START = "// analytics-routes-retire-allowlist-start";
const NEXT_CONFIG_ALLOWLIST_END = "// analytics-routes-retire-allowlist-end";

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

/** Replace the bounded allowlist region with same-line whitespace so line
 * numbers in the rest of the file stay accurate (the touch-ratchet keys on
 * 1-indexed new-side line numbers from `git diff --unified=0`). */
function stripAllowlistedNextConfigRegion(content) {
  const startIdx = content.indexOf(NEXT_CONFIG_ALLOWLIST_START);
  const endIdx = content.indexOf(NEXT_CONFIG_ALLOWLIST_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return content;
  const region = content.slice(startIdx, endIdx + NEXT_CONFIG_ALLOWLIST_END.length);
  // Preserve newlines so line numbers in the trailing content stay aligned.
  const blanked = region.replace(/[^\n]/g, " ");
  return content.slice(0, startIdx) + blanked + content.slice(endIdx + NEXT_CONFIG_ALLOWLIST_END.length);
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
    baseRef = resolveBaseRef("ANALYTICS_ROUTES_DIFF_BASE");
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
    if (file === NEXT_CONFIG_PATH) {
      content = stripAllowlistedNextConfigRegion(content);
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
        `✓ no NEW analytics old-route references introduced by this PR ` +
          `(${toleratedFileCount} legacy file(s) still carrying refs — tolerated).`,
      );
    } else {
      console.log("✓ no analytics old-route references found.");
    }
    return;
  }

  console.error(
    "ERROR: analytics routes were renamed —\n" +
      "NEW references introduced by this PR were found:\n",
  );
  for (const { file, lines } of findings) {
    console.error(`  ${file} — line(s) ${lines.join(", ")}`);
  }
  console.error(
    "\nUse the new routes: /analytics/llm, /analytics/llm-usage, /analytics/api.\n" +
      "Old links 308-redirect via next.config.ts; do not write to old literals.\n" +
      "Package specifiers (@cinatra-ai/metric-cost-api, @cinatra-ai/metric-usage-api)\n" +
      "and MCP primitives (metric_cost_*, metric_usage_*) are intentionally stable.",
  );
  process.exit(1);
}

main();
