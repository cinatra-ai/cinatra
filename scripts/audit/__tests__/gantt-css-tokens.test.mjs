// Tests for the Gantt CSS token-consistency gate.
//
// Contract lives in scripts/audit/gantt-css-tokens.mjs:
//   - Single-file scan of src/components/workflows/gantt-overrides.css
//   - Comments stripped before scanning (so doctrine prose may mention raw colors)
//   - Allowlist: var(--*), currentColor, transparent, inherit, initial, unset, none
//   - color-mix(...) allowed when constituents are allowlisted

import { describe, it, expect } from "vitest";
import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  TARGET_REL,
  ALLOWED_COLOR_TOKENS,
  stripCssComments,
  scanCssBody,
  scanCssFile,
} from "../gantt-css-tokens.mjs";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const GATE_SCRIPT = resolve(REPO_ROOT, "scripts/audit/gantt-css-tokens.mjs");
const TARGET_ABS = resolve(REPO_ROOT, TARGET_REL);

// ---------------------------------------------------------------------------
// Live smoke — the in-tree gantt-overrides.css must pass.

describe("gantt-css-tokens — live smoke", () => {
  it("the in-tree override file passes the gate", async () => {
    const hits = await scanCssFile(TARGET_ABS);
    expect(hits).toEqual([]);
  });

  it("running the gate script against the worktree exits 0", () => {
    const r = spawnSync("node", [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PASS");
  });
});

// ---------------------------------------------------------------------------
// stripCssComments — line/col preservation

describe("stripCssComments", () => {
  it("removes block comments but preserves line numbers", () => {
    const src = "a {\n  /* comment\n   spans lines */\n  color: red;\n}\n";
    const out = stripCssComments(src);
    // Same number of lines as input.
    expect(out.split("\n").length).toBe(src.split("\n").length);
    // The literal `red` token survives the strip — only the comment is gone.
    expect(out).toMatch(/color:\s*red;/);
    // The comment body should be replaced with whitespace.
    expect(out).not.toContain("comment");
    expect(out).not.toContain("spans lines");
  });

  it("handles unterminated comment by consuming to EOF", () => {
    const src = "color: red; /* unterminated\nline 2 also\n";
    const out = stripCssComments(src);
    expect(out).toContain("color: red;");
    expect(out).not.toContain("unterminated");
  });

  it("leaves source without comments unchanged", () => {
    const src = "[data-gantt-shell] .wx-row { color: var(--color-foreground); }\n";
    expect(stripCssComments(src)).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// scanCssBody — one per raw-color form, plus the allowlist contract

describe("scanCssBody", () => {
  it("returns no hits for an all-token body", () => {
    const body = `
      [data-gantt-shell] .wx-row {
        color: var(--color-foreground);
        background: var(--color-surface);
        border: 1px solid var(--color-line-strong);
      }
      [data-gantt-shell] .wx-bar:focus-visible {
        outline: 2px solid var(--color-ring);
      }
    `;
    expect(scanCssBody(body)).toEqual([]);
  });

  it("allows color-mix() when every constituent is a token", () => {
    const body = `
      [data-gantt-shell] .gantt-actual-bar {
        background: color-mix(in oklab, var(--color-primary) 28%, transparent);
      }
    `;
    expect(scanCssBody(body)).toEqual([]);
  });

  it("allows the structural literals: currentColor, transparent, inherit, etc.", () => {
    const body = `
      a { color: currentColor; background: transparent; border-color: inherit; }
      b { box-shadow: none; }
    `;
    expect(scanCssBody(body)).toEqual([]);
    // Sanity — the allowlist set is what we say it is.
    for (const tok of ["currentColor", "transparent", "inherit", "initial", "unset", "none"]) {
      expect(ALLOWED_COLOR_TOKENS.has(tok)).toBe(true);
    }
  });

  it("flags a 6-digit hex literal", () => {
    const hits = scanCssBody("a { color: #ff0000; }");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "hex", match: "#ff0000" });
  });

  it("flags a 3-digit hex literal", () => {
    const hits = scanCssBody("a { background: #abc; }");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "hex", match: "#abc" });
  });

  it("flags rgb() and rgba()", () => {
    const hits = scanCssBody("a { color: rgb(255, 0, 0); border: 1px solid rgba(0, 0, 0, 0.5); }");
    expect(hits.map((h) => h.kind)).toEqual(expect.arrayContaining(["rgb"]));
    expect(hits).toHaveLength(2);
  });

  it("flags hsl(), hsla(), oklab(), oklch() as raw color functions", () => {
    const body = `
      a { color: hsl(120, 100%, 50%); background: hsla(0, 0%, 0%, 0.1); }
      b { color: oklab(0.5 0.2 0.2); border-color: oklch(0.5 0.1 200); }
    `;
    const hits = scanCssBody(body);
    const kinds = hits.map((h) => h.kind).sort();
    expect(kinds).toEqual(["hsl", "hsl", "oklab-raw", "oklch-raw"]);
  });

  it("flags named CSS colors (red, blue, gray, etc.) as raw", () => {
    const body = `
      a { color: red; }
      b { color: BLUE; }
      c { color: gray; }
    `;
    const hits = scanCssBody(body);
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.kind)).toEqual(["named", "named", "named"]);
  });

  it("does not flag named-color substrings inside identifiers", () => {
    // `whitespace`, `--my-red-token`, `redColor` — none should trip.
    const body = `
      a { white-space: nowrap; }
      b { --my-red-token: var(--color-primary); color: var(--my-red-token); }
    `;
    expect(scanCssBody(body)).toEqual([]);
  });

  it("reports line and column for hits", () => {
    // The gate only scans inside `{ ... }` rule blocks (so property names and
    // selectors are never matched as colors). Use a minimal block here.
    const body = "a {\n  color: red;\n}\n";
    const hits = scanCssBody(body);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "named", match: "red", line: 2 });
    // Column points at the `r` in `red` on line 2 — that's somewhere after
    // `  color: `; we don't pin the exact column to keep this resilient to
    // formatting tweaks in the body literal.
    expect(hits[0].col).toBeGreaterThan(1);
  });

  it("does NOT flag CSS property names that coincide with deprecated system colors", () => {
    // `background` and `menu` are deprecated CSS system-color names, but they
    // are also CSS property names. The scanner skips selectors and property
    // names by only scoping into value spans, so the property `background:`
    // never registers as a color hit.
    const body = "a { background: var(--color-surface); menu: var(--color-foreground); }";
    expect(scanCssBody(body)).toEqual([]);
  });

  it("ignores raw-color tokens inside CSS comments after stripping", () => {
    const src = "/* this red comment should not trip */\n.wx-row { color: var(--color-foreground); }\n";
    const body = stripCssComments(src);
    expect(scanCssBody(body)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI behaviour — exit codes + reporting on synthetic violation fixtures

describe("gantt-css-tokens CLI — synthetic fixtures", () => {
  function buildFakeRepo({ overrideCss }) {
    const tmp = mkdtempSync(join(tmpdir(), "gantt-css-tokens-"));
    execSync("git init -q", { cwd: tmp });
    // Two separate no-shell calls so we don't rely on `/bin/zsh` (absent on
    // ubuntu-latest CI runners) or platform-default shell semantics.
    execSync("git config user.email test@example.com", { cwd: tmp });
    execSync("git config user.name Test", { cwd: tmp });
    const targetDir = join(tmp, "src/components/workflows");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "gantt-overrides.css"), overrideCss);
    return tmp;
  }

  it("exits 0 on a clean fixture", () => {
    const tmp = buildFakeRepo({
      overrideCss: "[data-gantt-shell] .wx-row { color: var(--color-foreground); }\n",
    });
    const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PASS");
  });

  it("exits 1 and reports the planted hex violation", () => {
    const tmp = buildFakeRepo({
      overrideCss:
        "[data-gantt-shell] .wx-row { background: #ff0000; color: var(--color-foreground); }\n",
    });
    const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL");
    expect(r.stderr).toContain("#ff0000");
    expect(r.stderr).toContain("hex");
  });

  it("exits 1 on a planted rgb() violation", () => {
    const tmp = buildFakeRepo({
      overrideCss:
        "[data-gantt-shell] .wx-row { background: rgb(255, 0, 0); color: var(--color-foreground); }\n",
    });
    const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("rgb");
  });

  it("exits 1 on a planted named-color violation", () => {
    // Every CSS Color Module Level 4 named color is in the gate's list.
    // Tomato + rebeccapurple are deeper-list names that an under-coverage
    // gate would miss — they MUST be flagged.
    for (const planted of ["red", "tomato", "rebeccapurple"]) {
      const tmp = buildFakeRepo({
        overrideCss: `[data-gantt-shell] .wx-row { background: ${planted}; color: var(--color-foreground); }\n`,
      });
      const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(planted);
    }
  });

  it("exits 1 on planted system-color, color(), device-cmyk(), and light-dark() violations", () => {
    const fixtures = [
      { name: "system-color", body: "a { color: CanvasText; }", needle: "CanvasText" },
      { name: "color-fn", body: "a { color: color(display-p3 1 0 0); }", needle: "color-fn" },
      { name: "device-cmyk", body: "a { color: device-cmyk(0 1 1 0); }", needle: "device-cmyk" },
      { name: "light-dark", body: "a { color: light-dark(white, black); }", needle: "light-dark" },
    ];
    for (const { name, body, needle } of fixtures) {
      const tmp = buildFakeRepo({
        overrideCss: `[data-gantt-shell] .wx-row { ${body} }\n`,
      });
      const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
      expect(r.status, `${name} fixture should fail`).toBe(1);
      expect(r.stderr).toContain(needle);
    }
  });

  it("exits 2 when the override file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gantt-css-tokens-"));
    execSync("git init -q", { cwd: tmp });
    const r = spawnSync("node", [GATE_SCRIPT], { cwd: tmp, encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("missing");
  });
});
