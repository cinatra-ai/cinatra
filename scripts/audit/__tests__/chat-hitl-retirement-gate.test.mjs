// Fixture tests for the PRODUCTION-BOUNDARY RETIREMENT IDENTITY gate
// (cinatra#2573, epic #2564 S7).
//
// The criterion this gate serves is an EXACT-IDENTITY one, and the whole reason
// it is worded that way is that a naive substring grep is actively wrong here:
// `code-reviewer-agent` and `security-reviewer-agent` are RETAINED, shipped
// packages, and a guard that failed on them would be turned off within a week.
// So the tests hold four things:
//
//   1. DISCRIMINATION. The pattern matches every retired identity and NONE of
//      the retained look-alikes — asserted in both the scoped-ref and the bare
//      slug construction, since the slug form is the one that needs a LEFT
//      boundary and is where the naive version breaks.
//   2. TEETH. A synthetic re-introduction FAILS, on each of the three scans
//      (production boundary, whole tree, stale fixture).
//   3. THE COMMENT RULE IS DELIBERATE. A prose mention on the production
//      boundary is clean (a retirement documents itself); a live reference on
//      the same line is not. Both directions are pinned so the rule stays a
//      decision rather than an accident of the lexer.
//   4. The gate exits 0 on the real tree.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RETIRED_IDENTITIES,
  RETAINED_LOOKALIKES,
  WHOLE_TREE_ZERO,
  FIXTURE_SURFACES,
  PRODUCTION_PATHSPECS,
  boundaryPattern,
  slugBoundaryPattern,
  collectViolations,
  discriminationReport,
} from "../chat-hitl-retirement-gate.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts", "audit", "chat-hitl-retirement-gate.mjs");

describe("the pattern discriminates", () => {
  it("the boundary pattern DISCRIMINATES against every retained look-alike", () => {
    expect(discriminationReport()).toEqual([]);
  });

  it("the SCOPED construction matches each retired ref and no retained package", () => {
    for (const id of RETIRED_IDENTITIES) {
      const re = new RegExp(boundaryPattern(id));
      expect(re.test(id), id).toBe(true);
      for (const keep of RETAINED_LOOKALIKES) expect(re.test(keep), `${id} vs ${keep}`).toBe(false);
    }
  });

  it("the SLUG construction needs its LEFT boundary — the naive version would swallow the retained packages", () => {
    const slugRe = new RegExp(slugBoundaryPattern("@cinatra-ai/reviewer-agent"));
    expect(slugRe.test("reviewer-agent")).toBe(true);
    // The exact failure the left boundary exists to prevent.
    expect(slugRe.test("code-reviewer-agent")).toBe(false);
    expect(slugRe.test("security-reviewer-agent")).toBe(false);
    // …and the naive pattern (no left boundary) really WOULD have matched, so
    // this assertion is discrimination rather than a tautology.
    expect(new RegExp("reviewer-agent(?![A-Za-z0-9._-])").test("code-reviewer-agent")).toBe(true);
  });

  it("names three retired identities, two of them at whole-tree zero", () => {
    expect(RETIRED_IDENTITIES).toHaveLength(3);
    expect(WHOLE_TREE_ZERO).toHaveLength(2);
    for (const id of WHOLE_TREE_ZERO) expect(RETIRED_IDENTITIES).toContain(id);
  });
});

describe("the gate has teeth", () => {
  const fakeIo = (files) => ({
    listFilesImpl: () => Object.keys(files),
    readFileImpl: (rel) => {
      if (!(rel in files)) throw new Error("nope");
      return files[rel];
    },
  });

  it("a re-introduced package ref on the PRODUCTION BOUNDARY fails", () => {
    const id = RETIRED_IDENTITIES[2]; // the trigger identity
    const v = collectViolations(
      fakeIo({ "src/lib/thing.ts": `const pkg = "${id}";\n` }),
    );
    expect(v.some((x) => x.scan === "production-boundary")).toBe(true);
  });

  it("a re-introduced identity anywhere in the tree fails the WHOLE-TREE scan", () => {
    const id = WHOLE_TREE_ZERO[0];
    const v = collectViolations(fakeIo({ "docs/notes.md": `see ${id} for history\n` }));
    expect(v.some((x) => x.scan === "whole-tree")).toBe(true);
  });

  it("a stale FIXTURE naming a retired package by bare slug fails", () => {
    const v = collectViolations({
      listFilesImpl: () => [],
      readFileImpl: (rel) =>
        rel === FIXTURE_SURFACES[0] ? 'const f = { slug: "trigger-agent" };\n' : (() => {
          throw new Error("nope");
        })(),
    });
    expect(v.some((x) => x.scan === "stale-fixture")).toBe(true);
  });

  it("a RETAINED package in the same fixture is clean — the discrimination holds end to end", () => {
    const v = collectViolations({
      listFilesImpl: () => [],
      readFileImpl: (rel) =>
        rel === FIXTURE_SURFACES[0]
          ? 'const f = { packageName: "@cinatra-ai/code-reviewer-agent" };\n'
          : (() => {
              throw new Error("nope");
            })(),
    });
    expect(v).toEqual([]);
  });
});

describe("the comment rule is a decision, not an accident", () => {
  it("a PROSE mention on the production boundary is clean", () => {
    const id = RETIRED_IDENTITIES[2];
    const v = collectViolations({
      listFilesImpl: () => ["packages/trigger/src/index.ts"],
      readFileImpl: () => `// consumed by ${id}.\nexport const x = 1;\n`,
    });
    expect(v).toEqual([]);
  });

  it("a LIVE reference in the same module is NOT clean", () => {
    const id = RETIRED_IDENTITIES[2];
    const v = collectViolations({
      listFilesImpl: () => ["packages/trigger/src/index.ts"],
      readFileImpl: () => `// consumed by ${id}.\nexport const PKG = "${id}";\n`,
    });
    expect(v.some((x) => x.scan === "production-boundary")).toBe(true);
  });

  it("a shell fixture's `#` note is clean but its FILTER assignment is not", () => {
    const io = (body) => ({
      listFilesImpl: () => [],
      readFileImpl: (rel) =>
        rel === "tests/e2e/agents-run/run-batched.sh"
          ? body
          : (() => {
              throw new Error("nope");
            })(),
    });
    expect(collectViolations(io("# the trigger-agent batch was removed\n"))).toEqual([]);
    expect(
      collectViolations(io('BATCH1_FILTER="@cinatra-ai/(trigger-agent)"\n')).length,
    ).toBeGreaterThan(0);
  });

  it("the production pathspec EXCLUDES tests — a synthetic package name in a unit test is not a violation", () => {
    expect(PRODUCTION_PATHSPECS).toContain(":(exclude)**/__tests__/**");
    expect(PRODUCTION_PATHSPECS).toContain(":(exclude)**/*.test.ts");
  });
});

describe("the live tree", () => {
  it("is CLEAN", () => {
    expect(collectViolations()).toEqual([]);
  });

  it("the CLI exits 0", () => {
    const res = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.stdout + res.stderr).toMatch(/clean/);
    expect(res.status).toBe(0);
  });
});
