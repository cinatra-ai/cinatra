/**
 * One-shot removal guard for `src/lib/toast.ts`.
 *
 * The legacy `@/lib/toast` wrapper was deleted after all importers migrated
 * to `@/lib/cinatra-toast`. This test fails loudly if anyone re-introduces
 * an import from the old path — guarding against accidental reinstatement via
 * copy-paste, a stale snippet, or a merge that brings the legacy file back.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LEGACY_PATH = path.join(REPO_ROOT, "src/lib/toast.ts");

// Source roots that may import the legacy module. These are the only trees the
// guard needs to scan; everything else (node_modules, build output, etc.) is
// irrelevant and must never be walked.
const SCAN_ROOTS = ["src", "packages", "extensions"] as const;

// The previous implementation shelled out to `grep -R … src packages
// extensions`, whose `-R` flag descends into the *nested* node_modules trees
// that pnpm materialises under packages/* and extensions/* (~70 of them on a
// full install). That walk is pure, unnecessary IO; on a constrained CI runner
// already executing the wholesale `test:root` suite it starved past vitest's
// 30s ceiling and flaked the required "Perpetual system loops invariants"
// check (cinatra#160). Enumerating *tracked* (and not-yet-ignored) files via
// `git ls-files` instead structurally excludes every node_modules tree (they
// are gitignored), is deterministic, and runs in well under a second.

/**
 * List repository source files under SCAN_ROOTS using git's index, including
 * uncommitted-but-not-ignored files (`--others --exclude-standard`) so a freshly
 * authored offender is caught before it is committed. node_modules and other
 * gitignored trees are excluded by construction.
 */
function listSourceFiles(): string[] {
  const globs = SCAN_ROOTS.flatMap((root) => [
    `${root}/**/*.ts`,
    `${root}/**/*.tsx`,
  ]);
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter((p) => p.length > 0);
}

describe("legacy toast.ts removal guard", () => {
  it("src/lib/toast.ts is deleted", () => {
    expect(existsSync(LEGACY_PATH)).toBe(false);
  });

  it("no source file imports from the legacy toast path", () => {
    // The pattern is intentionally split so this guard file itself does NOT
    // match its own substring (otherwise the guard would always fail).
    const LEGACY = `from "@/lib/` + `toast"`;
    const GUARD_REL = path.relative(REPO_ROOT, __filename);

    const start = performance.now();
    const files = listSourceFiles();
    const offenders = files.filter((rel) => {
      // Skip this guard file. It avoids the literal pattern via the split
      // string above, so this is belt-and-suspenders against a future edit
      // that inadvertently reintroduces the literal here.
      if (rel === GUARD_REL) return false;
      const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      return text.includes(LEGACY);
    });
    const elapsedMs = performance.now() - start;

    if (offenders.length > 0) {
      throw new Error(
        `Found imports from the deleted '@/lib/toast' module — migrate to '@/lib/cinatra-toast':\n${offenders.join("\n")}`,
      );
    }
    expect(offenders).toEqual([]);

    // Runtime budget: the deterministic scan should finish in well under a
    // second. A generous 10s ceiling (vs vitest's 30s test timeout) turns any
    // future regression that reintroduces a node_modules-style walk into a
    // loud, actionable failure instead of an intermittent timeout flake.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
