// cinatra#1919 — WP/Drupal UAT gate paths-filter coverage regression.
//
// The gate at `.github/workflows/wp-drupal-uat.yml` runs the (expensive) full
// UAT suite on a PR only when a `relevant`-listed path changes. The suite boots
// the real app (`pnpm dev`) and drives the hosted-LLM MCP write path, so the
// filter MUST cover the modules that boot actually exercises — otherwise a PR
// changing a real boot-dependency skips the suite and gets a MISLEADING green
// required check (the exact defect in cinatra#1919: a PR touching only
// `src/lib/external-mcp-registry.ts` produced `run_uat=false`).
//
// This guard fails when a boot-dependency module is dropped from the filter, or
// when a listed exact-file path stops existing (a rename that would silently
// stop triggering the gate). It is intentionally a plain text parse — the repo
// ships no YAML parser and the filter block is a simple `- '<glob>'` list.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  ".github/workflows/wp-drupal-uat.yml",
);

// The boot-dependency modules the suite exercises and that MUST keep the gate
// running. `external-mcp-registry.ts` is the cinatra#1919 addition; the others
// are pre-existing critical boot inputs pinned here so a future filter edit
// cannot silently drop them.
const REQUIRED_BOOT_DEPENDENCY_PATHS = [
  "src/lib/external-mcp-registry.ts",
  "src/lib/dev-auto-setup.ts",
  "src/lib/wordpress-mcp-connection.ts",
  "src/lib/wp-drupal-contract.ts",
  "packages/llm/src/scripted-test-provider.ts",
];

/**
 * Extract the `relevant:` filter globs from the dorny/paths-filter `filters:`
 * block. Collects `- '<glob>'` entries after the `relevant:` key until the
 * indentation dedents back to (or past) the key's own indent on a non-list line
 * (the next filter key or job) — i.e. the end of the `relevant` list.
 */
function readRelevantFilterGlobs(): string[] {
  const src = readFileSync(WORKFLOW_PATH, "utf8");
  const lines = src.split("\n");
  const keyIdx = lines.findIndex((l) => /^\s*relevant:\s*$/.test(l));
  if (keyIdx === -1) {
    throw new Error(
      "wp-drupal-uat.yml: could not find a `relevant:` filter key — the UAT gate structure changed; update this guard.",
    );
  }
  const keyIndent = lines[keyIdx].match(/^\s*/)![0].length;
  const globs: string[] = [];
  for (let i = keyIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)![0].length;
    const listMatch = line.match(/^\s*-\s*'([^']+)'\s*$/);
    if (listMatch) {
      globs.push(listMatch[1]);
      continue;
    }
    // A non-list line at or below the key's indent ends the `relevant` block.
    if (indent <= keyIndent) break;
  }
  return globs;
}

describe("cinatra#1919 — WP/Drupal UAT paths-filter covers the suite's boot dependencies", () => {
  const globs = readRelevantFilterGlobs();

  it("parses a non-trivial `relevant` filter list", () => {
    expect(globs.length).toBeGreaterThanOrEqual(REQUIRED_BOOT_DEPENDENCY_PATHS.length);
  });

  it("covers external-mcp-registry.ts (the cinatra#1919 regression: it must trigger run_uat)", () => {
    expect(globs).toContain("src/lib/external-mcp-registry.ts");
  });

  it.each(REQUIRED_BOOT_DEPENDENCY_PATHS)(
    "covers boot-dependency module %s",
    (required) => {
      expect(globs).toContain(required);
    },
  );

  it("every exact-file glob in the filter still exists (a rename would silently stop triggering the gate)", () => {
    const missing = globs
      .filter((g) => !g.includes("*")) // only exact file paths, not directory globs
      .filter((g) => !existsSync(path.join(REPO_ROOT, g)));
    expect(missing, `filter references non-existent path(s): ${missing.join(", ")}`).toEqual([]);
  });
});
