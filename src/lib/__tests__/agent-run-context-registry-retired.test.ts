/**
 * cinatra#1195 — the in-process agent run-context registry is RETIRED.
 *
 * The registry was a process-local `Map` that could not survive multiple app
 * instances/workers and whose shared per-provider clientId fallback key could
 * misattribute concurrent runs. This suite is the DELETION LOCK: it fails if the
 * module, an import edge to it, or a live call site of its API comes back —
 * including via a `vi.mock` in a test, which is how a phantom dependency usually
 * survives a deletion.
 *
 * It scans tracked source (not node_modules / build output) rather than relying
 * on a compile error, because a re-introduction would typecheck perfectly well.
 * COMMENTS ARE STRIPPED BEFORE MATCHING: the retirement is documented in prose
 * across several modules on purpose, and that prose must not read as a
 * violation. String literals are deliberately KEPT so a `vi.mock("…")` or a
 * dynamic `import("…")` of the deleted path is still caught.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["src", "packages", "scripts"];
const SCAN_EXTS = [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  "extensions",
]);

/** Files that name a retired symbol ON PURPOSE, to assert its ABSENCE. Kept as
 *  an explicit, minimal allowlist (never a pattern): every entry is a test that
 *  would otherwise report itself, and a NEW entry is a deliberate decision. */
const ABSENCE_ASSERTERS = new Set([
  join("src", "lib", "__tests__", "agent-run-context-registry-retired.test.ts"),
  // Asserts the transport no longer reads the registry option.
  join(
    "packages",
    "mcp-server",
    "src",
    "__tests__",
    "run-context-denied-response.test.ts",
  ),
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue; // a dangling symlink is not a source file
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (SCAN_EXTS.some((e) => entry.endsWith(e))) {
      yield full;
    }
  }
}

/** Blank out `//` and block comments while preserving offsets, string-aware so
 *  a `//` inside a string literal is not mistaken for a comment. Good enough
 *  for a source-hygiene scan (it is not a parser). */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (inStr) {
      if (c === "\\") {
        out += c + (d ?? "");
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function scanSources(): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = file.slice(REPO_ROOT.length + 1);
      if (ABSENCE_ASSERTERS.has(rel)) continue;
      out.push({ path: rel, code: stripComments(readFileSync(file, "utf8")) });
    }
  }
  return out;
}

describe("in-process run-context registry retirement (#1195)", () => {
  it("the module file is gone", () => {
    expect(
      existsSync(join(REPO_ROOT, "src/lib/agent-run-context-registry.ts")),
    ).toBe(false);
  });

  it("no import edge, dynamic import, or test mock names the module path", () => {
    const offenders = scanSources()
      .filter((f) => f.code.includes("agent-run-context-registry"))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("no live call site or wiring of the registry API survives", () => {
    // `getRunContext` was ALSO the mcp-server transport option name, so this
    // covers the deleted app module and the deleted wiring in one assertion.
    const api = ["setRunContext", "clearRunContext", "getRunContext"];
    const offenders = scanSources()
      .filter((f) => api.some((sym) => new RegExp(`\\b${sym}\\b`).test(f.code)))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
