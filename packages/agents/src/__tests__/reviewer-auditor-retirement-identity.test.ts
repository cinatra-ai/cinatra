/**
 * cinatra#2042 (epic #2037 S4) — the reviewer-agent / auditor-agent RETIREMENT
 * identity gate.
 *
 * The AC requires the retirement grep to be EXACT-IDENTITY: the package refs
 * `@cinatra-ai/reviewer-agent` and `@cinatra-ai/auditor-agent` (and their binding
 * ids `…:<binding>`), NOT a plain `reviewer-agent` substring — so RETAINED
 * packages like `code-reviewer-agent` / `security-reviewer-agent` never trip it.
 *
 * COORDINATION STATE (recorded honestly): the agent retirement is coordination-
 * blocked on #1796's reviewer-RENDERING teardown, which is NOT yet on main — the
 * `@cinatra-ai/reviewer-agent:output` renderer is still actively REUSED (e.g. by
 * blog-idea-selection), and the e2e agent fixtures still exercise both agents. A
 * destructive removal now would break the suite. So this test is the GATE the AC
 * names in its enforceable form:
 *
 *   (1) it PROVES the exact-identity matcher discriminates (retained *-reviewer-
 *       agent packages are never matched);
 *   (2) it RATCHETS the current reference inventory so it can only SHRINK — a new
 *       reference to either retiring agent fails the build, and when #1796 lands
 *       and the agents are removed the counts fall to zero (drop the baseline).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/** The exact-identity retiring-agent package refs. */
const RETIRING = ["@cinatra-ai/reviewer-agent", "@cinatra-ai/auditor-agent"] as const;

/** Files that legitimately reference the retiring agents by EXACT identity today
 * (the ratchet baseline). The retirement is blocked on #1796; this count must only
 * SHRINK. When #1796 lands, drop these to 0. */
const BASELINE_FILE_COUNT: Record<(typeof RETIRING)[number], number> = {
  "@cinatra-ai/reviewer-agent": 26,
  "@cinatra-ai/auditor-agent": 23,
};

/** This guard file names the retiring refs to DEFINE the matcher — exclude it from
 * its own inventory (it is the gate, not a live reference). */
const SELF = "packages/agents/src/__tests__/reviewer-auditor-retirement-identity.test.ts";

function fileCountExactId(pkg: string): number {
  // `-F` fixed-string, exact package ref; `-l` list files; `git grep` respects
  // .gitignore (never scans node_modules). Exclude this guard file. Empty match ⇒
  // non-zero exit ⇒ 0 files.
  try {
    const out = execSync(`git grep -l -F ${JSON.stringify(pkg)} -- . ${JSON.stringify(`:!${SELF}`)}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

describe("cinatra#2042 — reviewer/auditor retirement identity gate", () => {
  it("EXACT-IDENTITY: the retiring package refs never match a RETAINED *-reviewer-agent package", () => {
    // A retained package's ref must NOT contain either exact retiring ref.
    const retained = ["@cinatra-ai/code-reviewer-agent", "@cinatra-ai/security-reviewer-agent"];
    for (const keep of retained) {
      for (const retire of RETIRING) {
        expect(keep.includes(retire)).toBe(false);
      }
    }
  });

  it("RATCHET: the exact-identity reference inventory only SHRINKS (a new reference fails; retirement drives it to zero)", () => {
    for (const pkg of RETIRING) {
      const count = fileCountExactId(pkg);
      // The inventory must never GROW past the recorded baseline while the
      // retirement waits on #1796. A drop is expected and welcome (update the
      // baseline down); a rise is a regression (a new reference to a retiring agent).
      expect(count).toBeLessThanOrEqual(BASELINE_FILE_COUNT[pkg]);
    }
  });

  it("the retirement is TRACKED — the baseline is documented so the gate flips to zero when #1796 lands", () => {
    // A guard on the guard: the baseline map covers exactly the retiring set, so a
    // future contributor cannot silently add a new retiring agent without a baseline.
    expect(Object.keys(BASELINE_FILE_COUNT).sort()).toEqual([...RETIRING].sort());
  });
});
