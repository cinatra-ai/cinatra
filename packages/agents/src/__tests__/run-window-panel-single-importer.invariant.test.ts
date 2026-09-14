/**
 * E1 — ONE IMPORTER OF THE RUN-WINDOW PANEL, AND IT IS THE RUN PAGE'S CHROME
 * (cinatra#3487).
 *
 * The ruling, in its own words: "the run page's frame mounts exactly ONE prompt
 * window in its chrome; every step screen, the review route and every lifecycle
 * card stop mounting one" — and the enforcement it names: "a structural
 * invariant walking the import graph from the run-window panel's module:
 * exactly ONE importer — the run page chrome — and no lifecycle card, step
 * screen, review route or chat component; the allowlist a single literal in the
 * test; failing names every other importer."
 *
 * THE ALLOWLIST IS THE SINGLE LITERAL BELOW. Widening it is a change to this
 * file, which is on the attribution gate's high-risk path list, so it needs a
 * maintainer-tier approval rather than a quiet edit inside a feature diff.
 *
 * NO WAIVER, NO ENVIRONMENT SWITCH, NO SKIP (E6): this file reads the tree it is
 * run against and has no conditional of any kind.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/run-window-panel-single-importer.invariant.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * THE ALLOWLIST — one literal, and the module it names is the run page's
 * chrome. Nothing else in the product may import the panel.
 */
const THE_ONE_IMPORTER = "packages/agents/src/run-page-chrome.tsx";

/** The panel module the invariant walks from. */
const PANEL_MODULE = "packages/agents/src/hitl-conversation-panel.tsx";

/** Where product source lives. `tests/` and `__tests__/` are not product. */
const SOURCE_ROOTS = ["src", "packages", "extensions"];

const SKIP_DIR = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
  "__tests__",
  "__mocks__",
]);

const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry)) continue;
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!SOURCE_EXT.has(path.extname(entry))) continue;
    // A test file is not a product module: it may read the panel's own exports
    // to measure them. The invariant is about what SHIPS.
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
    out.push(full);
  }
}

/**
 * Every way the panel's module can be named from another file: the relative
 * specifier inside the package, and the package's own subpath export.
 */
const SPECIFIER = /from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

function resolvesToThePanel(fromFile: string, specifier: string): boolean {
  if (specifier.startsWith(".")) {
    const abs = path.resolve(path.dirname(fromFile), specifier);
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
    return rel === PANEL_MODULE.replace(/\.tsx$/, "");
  }
  return (
    specifier === "@cinatra-ai/agents/hitl-conversation-panel" ||
    specifier.endsWith("/src/hitl-conversation-panel")
  );
}

function importersOfThePanel(): string[] {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    walk(abs, files);
  }
  const importers = new Set<string>();
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (rel === PANEL_MODULE) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("hitl-conversation-panel")) continue;
    SPECIFIER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SPECIFIER.exec(text)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (resolvesToThePanel(file, spec)) importers.add(rel);
    }
  }
  return [...importers].sort();
}

describe("E1 — the run-window panel has exactly one importer", () => {
  it("is imported by the run page chrome and by nothing else", () => {
    expect(existsSync(path.join(REPO_ROOT, PANEL_MODULE))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, THE_ONE_IMPORTER))).toBe(true);

    const importers = importersOfThePanel();
    const offenders = importers.filter((f) => f !== THE_ONE_IMPORTER);

    // FAILING NAMES EVERY OTHER IMPORTER, which is the ruling's own wording.
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `The run-window panel may be imported by ${THE_ONE_IMPORTER} alone ` +
            `(cinatra#3487). These modules import it and must not: ` +
            offenders.join(", "),
    ).toEqual([]);
    expect(importers).toEqual([THE_ONE_IMPORTER]);
  });

  it("names no lifecycle card, step screen, review route or chat component", () => {
    const importers = importersOfThePanel();
    const forbidden = importers.filter((f) =>
      /card|screen|review|chat|stepper|panel\.tsx$/.test(
        f.replace("run-page-chrome.tsx", ""),
      ),
    );
    expect(forbidden).toEqual([]);
  });

  it("carries no waiver flag, environment switch or skip list (E6)", () => {
    const self = readFileSync(
      path.join(__dirname, "run-window-panel-single-importer.invariant.test.ts"),
      "utf8",
    );
    expect(/\b(it|describe|test)\.(skip|todo)\b/.test(self)).toBe(false);
    expect(/\bprocess\.env\b/.test(self)).toBe(false);
  });
});
