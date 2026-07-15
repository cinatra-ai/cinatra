// Fixture tests for the shell-surface / pixel-baseline pairing heuristic
// (#1600). Guards the detection logic that the warn workflow depends on:
// the surface membership, the false-positive guardrails (sub-routes, test
// files, both-changed, neither-changed), and path normalization.
//
// Runner: hosted by the vitest include glob `scripts/ci/__tests__/**/*.test.{ts,mjs}`.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluatePairing,
  isShellSurface,
  isBaseline,
  normalizePath,
  SHELL_SURFACES,
  BASELINE_DIR,
  warningBody,
  resolvedBody,
  COMMENT_MARKER,
  REFRESH_COMMAND,
} from "../shell-baseline-pairing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "../shell-baseline-pairing.mjs");

const BASELINE = `${BASELINE_DIR}design-fixtures-light.png`;

describe("evaluatePairing — fires (warn=true) on an unpaired shell change", () => {
  const shellCases = [
    "src/components/app-shell.tsx",
    "src/components/app-sidebar.tsx",
    "src/components/ui/sidebar.tsx",
    "src/app/globals.css",
    "src/app/design-fixtures/page.tsx",
    "src/app/design-fixtures/sidebar-fixture.tsx",
    "src/app/design-fixtures/token-swatches.tsx",
  ];
  for (const f of shellCases) {
    it(`warns on ${f} with no paired baseline`, () => {
      const r = evaluatePairing([f, "src/lib/unrelated.ts"]);
      expect(r.warn).toBe(true);
      expect(r.shellFiles).toContain(f);
    });
  }
});

describe("evaluatePairing — does NOT fire (guardrails / AC #2)", () => {
  it("no warn when a paired baseline is in the same diff (both changed)", () => {
    const r = evaluatePairing(["src/components/app-shell.tsx", BASELINE]);
    expect(r.warn).toBe(false);
    expect(r.baselineFiles).toContain(BASELINE);
  });

  it("no warn when neither surface class changed", () => {
    const r = evaluatePairing(["src/lib/foo.ts", "README.md", "package.json"]);
    expect(r.warn).toBe(false);
    expect(r.shellFiles).toEqual([]);
  });

  it("no warn on a baseline-only refresh PR", () => {
    const r = evaluatePairing([BASELINE, `${BASELINE_DIR}design-fixtures-dark.png`]);
    expect(r.warn).toBe(false);
  });

  it("no warn on an empty diff", () => {
    expect(evaluatePairing([]).warn).toBe(false);
    expect(evaluatePairing(undefined).warn).toBe(false);
  });

  it("EXCLUDES design-fixtures sub-routes (no committed pixel baseline)", () => {
    for (const sub of [
      "src/app/design-fixtures/conformance/page.tsx",
      "src/app/design-fixtures/conformance/seed/route.ts",
      "src/app/design-fixtures/header-rule/page.tsx",
      "src/app/design-fixtures/extension-settings/page.tsx",
      "src/app/design-fixtures/access-picker/__tests__/x.test.tsx",
    ]) {
      expect(isShellSurface(sub)).toBe(false);
      expect(evaluatePairing([sub]).warn).toBe(false);
    }
  });

  it("EXCLUDES top-level fixture test/spec files", () => {
    expect(isShellSurface("src/app/design-fixtures/thing.test.tsx")).toBe(false);
    expect(isShellSurface("src/app/design-fixtures/thing.spec.ts")).toBe(false);
  });

  it("EXCLUDES top-level fixture NON-renderable files (README/json/snap)", () => {
    expect(isShellSurface("src/app/design-fixtures/README.md")).toBe(false);
    expect(isShellSurface("src/app/design-fixtures/data.json")).toBe(false);
    expect(isShellSurface("src/app/design-fixtures/page.tsx.snap")).toBe(false);
  });

  it("a non-.png change under the baseline dir does NOT count as a paired refresh", () => {
    const r = evaluatePairing(["src/app/globals.css", "tests/e2e/design/__screenshots__/README.md"]);
    expect(r.warn).toBe(true);
    expect(r.baselineFiles).toEqual([]);
  });

  it("does not match near-miss paths outside the surface set", () => {
    expect(isShellSurface("src/components/ui/button.tsx")).toBe(false);
    expect(isShellSurface("src/components/app-shell.test.tsx")).toBe(false);
    expect(isShellSurface("src/app/globals.d.ts")).toBe(false);
  });
});

describe("normalization & dedup", () => {
  it("strips a leading ./", () => {
    expect(normalizePath("./src/app/globals.css")).toBe("src/app/globals.css");
    expect(evaluatePairing(["./src/app/globals.css"]).warn).toBe(true);
  });
  it("drops blanks and comment lines", () => {
    expect(normalizePath("")).toBe("");
    expect(normalizePath("   ")).toBe("");
    expect(normalizePath("# a comment")).toBe("");
  });
  it("counts a duplicated path once", () => {
    const r = evaluatePairing(["src/app/globals.css", "src/app/globals.css"]);
    expect(r.shellFiles.length).toBe(1);
  });
  it("normalizes backslash separators", () => {
    expect(normalizePath("src\\app\\globals.css")).toBe("src/app/globals.css");
  });
});

describe("baseline detection", () => {
  it("recognizes a .png under the baseline dir only", () => {
    expect(isBaseline(BASELINE)).toBe(true);
    expect(isBaseline("tests/e2e/design/__screenshots__/design-fixtures-dark.png")).toBe(true);
    expect(isBaseline("tests/e2e/design/config/design.config.ts")).toBe(false);
    // A non-image file living under the baseline dir must not count as a refresh.
    expect(isBaseline("tests/e2e/design/__screenshots__/README.md")).toBe(false);
  });
});

describe("surface list is the single source of truth (AC #3)", () => {
  it("carries a documented membership rule per surface", () => {
    expect(SHELL_SURFACES.length).toBeGreaterThan(0);
    for (const s of SHELL_SURFACES) {
      expect(typeof s.doc).toBe("string");
      expect(s.doc.length).toBeGreaterThan(10);
      expect(typeof s.test).toBe("function");
    }
  });
});

describe("published copy points at the documented refresh path (AC #1)", () => {
  it("warning body names the refresh command, the baseline dir and the marker", () => {
    const body = warningBody(["src/components/app-shell.tsx"]);
    expect(body).toContain(REFRESH_COMMAND);
    expect(body).toContain(BASELINE_DIR);
    expect(body).toContain("src/components/app-shell.tsx");
    expect(body).toContain(COMMENT_MARKER);
    expect(body).toContain("does **not** block");
  });
  it("resolved body carries the same sticky marker", () => {
    expect(resolvedBody()).toContain(COMMENT_MARKER);
  });
});

describe("CLI: --self-test dry-run exits 0", () => {
  it("runs the built-in fixture assertions the workflow uses", () => {
    const r = spawnSync("node", [SCRIPT, "--self-test"], { encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/self-test: \d+\/\d+ passed/);
  });
});

describe("CLI: positional-args evaluation writes GITHUB_OUTPUT", () => {
  it("emits warn=true for an unpaired shell change", () => {
    const tmp = path.join(__dirname, `._out_${process.pid}.txt`);
    const r = spawnSync("node", [SCRIPT, "src/components/app-shell.tsx"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, GITHUB_OUTPUT: tmp, GITHUB_STEP_SUMMARY: "" },
    });
    const out = fs.readFileSync(tmp, "utf8");
    fs.rmSync(tmp, { force: true });
    expect(r.status).toBe(0);
    expect(out).toContain("warn=true");
    expect(r.stdout).toContain("::warning::");
  });
});
