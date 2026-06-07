#!/usr/bin/env node
// True-IoC discovery-dispatcher bypass gate — NO-NEW-ROT ratchet.
//
// The runtime-discovery dispatcher (`discoverActiveExtensionCapabilities`) is the
// ONE sanctioned way a surface discovers active extension capabilities: it routes
// through the `installed_extension` lifecycle gate and the per-kind visibility
// reader (see docs/developer/extensions.md "Runtime capability discovery"). A
// surface that instead imports a per-kind native discovery reader DIRECTLY
// bypasses the gate — it can show uninstalled capabilities (no lifecycle gate) or
// the wrong actor's rows (no scope). This gate freezes the CURRENT direct readers
// as a baseline and fails CI on any NEW one, so discovery coupling can only
// SHRINK as surfaces migrate to the dispatcher.
//
// Gated symbol(s): the lifecycle-active agent reader the dispatcher mediates.
// (Add more readers here as their kinds adopt the dispatcher.)
//
// Allowlisted (sanctioned, never counted):
//   - the file that DEFINES the reader + the barrel that re-exports it
//   - the per-kind handler reader facet that IS the dispatcher's sanctioned caller
//   - tests.
//
// Usage:
//   node scripts/audit/discovery-dispatcher-bypass-ban.mjs            # --check (default)
//   node scripts/audit/discovery-dispatcher-bypass-ban.mjs --write-baseline
//   DISCOVERY_BYPASS_BASE=<ref> node ...                              # also fail if baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "discovery-dispatcher-bypass-ban.baseline.json");

// The native discovery readers the dispatcher mediates. A direct reference from a
// non-allowlisted, non-test file is a bypass. Word-boundary matched.
export const GATED_SYMBOLS = ["readActiveExtensionTemplates"];

// Sanctioned references (repo-relative, forward-slash). The reader's definition,
// its barrel re-export, and the per-kind handler facet that the dispatcher calls.
const ALLOWLIST = new Set([
  "packages/agents/src/store.ts", // defines readActiveExtensionTemplates
  "packages/agents/src/index.ts", // barrel re-export
  "packages/agents/src/extension-handler.ts", // the dispatcher's sanctioned agent reader facet
]);

// Roots scanned: app core + workspace packages (discovery surfaces live in both).
const SCAN_ROOTS = ["src", "packages"];

const SYMBOL_RE = new RegExp(`\\b(?:${GATED_SYMBOLS.join("|")})\\b`);

function isExemptFile(rel) {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(rel) ||
    /\/__tests__\//.test(rel) ||
    /\/__mocks__\//.test(rel) ||
    ALLOWLIST.has(rel)
  );
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist" || entry === "vendor") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// Strip line + block comments so commented-out / doc references don't false-trip.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Returns a sorted array of repo-relative files that DIRECTLY reference a gated symbol. */
export function scanBypassFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const hits = new Set();
  for (const root of roots) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, [])) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (isExemptFile(rel)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      if (SYMBOL_RE.test(code)) hits.add(rel);
    }
  }
  return [...hits].sort();
}

function sortDeep(o) {
  if (Array.isArray(o)) return [...o].sort();
  return o;
}
function stable(obj) {
  return JSON.stringify({ ...obj, files: sortDeep(obj.files) }, null, 2) + "\n";
}

export function diffFiles(baseline, current) {
  const base = new Set(baseline);
  const cur = new Set(current);
  const added = current.filter((f) => !base.has(f)).sort();
  const removed = baseline.filter((f) => !cur.has(f)).sort();
  return { added, removed };
}

/** committed baseline must be a SUBSET of the base-branch baseline (no regenerate-to-pass). */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const base = new Set(baseBaseline);
  return committedBaseline.filter((f) => !base.has(f)).sort();
}

function main() {
  const args = process.argv.slice(2);
  const current = scanBypassFiles();

  if (args.includes("--write-baseline")) {
    const doc = {
      note:
        "True-IoC discovery-dispatcher bypass baseline. Each file directly references a native discovery reader (GATED_SYMBOLS) instead of routing through discoverActiveExtensionCapabilities. Tolerated until migrated; the set may only ever SHRINK. Regenerate with `node scripts/audit/discovery-dispatcher-bypass-ban.mjs --write-baseline`. The reader definition/barrel + the per-kind handler facet are allowlisted (sanctioned), not baseline.",
      gatedSymbols: GATED_SYMBOLS,
      files: current,
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    console.log(`[discovery-dispatcher-bypass-ban] baseline written — ${current.length} bypass file(s).`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[discovery-dispatcher-bypass-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).files ?? [];

  // Monotonic guard: in CI the committed baseline must be a subset of the base ref's.
  const baseRef = process.env.DISCOVERY_BYPASS_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[discovery-dispatcher-bypass-ban] FAIL — DISCOVERY_BYPASS_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    // Fail-CLOSED: a set-but-unresolvable base ref must not silently disable the guard.
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[discovery-dispatcher-bypass-ban] FAIL — DISCOVERY_BYPASS_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/discovery-dispatcher-bypass-ban.baseline.json`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText).files ?? [], baseline);
      if (grew.length) {
        console.error(
          `[discovery-dispatcher-bypass-ban] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`,
        );
        grew.forEach((f) => console.error("  + " + f));
        process.exit(1);
      }
    }
  }

  const { added, removed } = diffFiles(baseline, current);
  if (removed.length) {
    console.log(`[discovery-dispatcher-bypass-ban] NOTE — ${removed.length} file(s) migrated off the direct reader (remove via --write-baseline):`);
    removed.forEach((f) => console.log("  - " + f));
  }
  if (added.length) {
    console.error(
      `[discovery-dispatcher-bypass-ban] FAIL — ${added.length} NEW discovery-dispatcher bypass(es) — route through discoverActiveExtensionCapabilities, not a direct ${GATED_SYMBOLS.join("/")} import:`,
    );
    added.forEach((f) => console.error("  + " + f));
    process.exit(1);
  }
  console.log(`[discovery-dispatcher-bypass-ban] OK — no NEW dispatcher bypass. Baseline: ${baseline.length} file(s) (migrate to the dispatcher to shrink).`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
