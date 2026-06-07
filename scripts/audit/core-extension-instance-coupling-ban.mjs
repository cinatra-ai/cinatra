#!/usr/bin/env node
// True-IoC structural gate — NO-NEW hardcoded extension-INSTANCE coupling.
//
// The sibling `core-extension-import-ban` gate catches core IMPORTING a specific
// extension package (`import ... from "@cinatra-ai/x-agent"`). This gate catches
// the OTHER way core hardcodes a specific extension INSTANCE: a string literal /
// JSX text / schema description / prompt / package-metadata reference to an exact
// extension package NAME, or an `extensions/<scope>/<name>/` PATH literal — e.g.
// `src/lib/blog/openai.ts`'s `"@cinatra-ai/blog-skills:generate-blog-ideas"` +
// `extensions/cinatra-ai/blog-skills/skills/${slug}/SKILL.md`. That is core
// knowing a specific extension by name, which a true IoC system must not do —
// capabilities come from the manifest/registry, not hardcoded references.
//
// NO-NEW-ROT ratchet (mirrors core-extension-import-ban): every current
// occurrence is recorded in the baseline as `file :: kind :: value -> count`;
// CI fails if any count GROWS or a NEW occurrence appears, and (with a base ref)
// if the committed baseline grew vs the base branch. The baseline can only
// SHRINK — the IoC cutover drives it to 0 (de-couple core from named instances).
//
// Counts ALL non-comment occurrences INCLUDING imports — the src-only
// import-ban gate does not scan `packages/`, so a package-side
// `import "@scope/ext"` would otherwise escape both gates. Path matches are
// validated against REAL `extensions/<scope>/<name>` dirs, so a core
// `@cinatra-ai/extensions/...` package subpath is not a false positive.
//
// EXEMPT (never scanned/counted):
//   - the `extensions/` tree itself (an extension naming ITSELF is fine);
//   - `src/lib/generated/**` (the generated manifest IS the legit data-driven
//     install list — names there are data, not hand-coupling);
//   - test / spec / __tests__ / tests / __mocks__ files.
//
// Usage:
//   node scripts/audit/core-extension-instance-coupling-ban.mjs            # --check (default)
//   node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
//   CORE_EXT_INSTANCE_BAN_BASE=<ref> node ...                              # also fail if baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_PATH = join(__dirname, "core-extension-instance-coupling-ban.baseline.json");

const SCAN_ROOTS = ["src", "packages"];
const EXTENSION_PATH_RE = /extensions\/[a-z0-9._-]+\/[a-z0-9._-]+/g;

/** Extension package names — derived from `extensions/<scope>/<name>/package.json`. */
export function discoverExtensionNames(extRoot = EXTENSIONS_ROOT) {
  return discoverExtensions(extRoot).names;
}

/**
 * Walk `extensions/<scope>/<name>/` once → both the package NAMES and the real
 * `extensions/<scope>/<name>` DIR PATHS. The dir-path set is what
 * `EXTENSION_PATH_RE` matches are validated against, so a CORE subpath like
 * `@cinatra-ai/extensions/components/...` (the core `packages/extensions`
 * package — NOT the `extensions/` folder) is NOT a false positive.
 */
export function discoverExtensions(extRoot = EXTENSIONS_ROOT) {
  const names = new Set();
  const dirPaths = new Set();
  if (!existsSync(extRoot)) return { names, dirPaths };
  for (const scope of readdirSync(extRoot)) {
    const scopeDir = join(extRoot, scope);
    if (!statSync(scopeDir).isDirectory()) continue;
    for (const pkg of readdirSync(scopeDir)) {
      const pkgDir = join(scopeDir, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;
      dirPaths.add(`extensions/${scope}/${pkg}`);
      const manifest = join(pkgDir, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (typeof name === "string" && name) names.add(name);
      } catch {
        /* skip unreadable manifest */
      }
    }
  }
  return { names, dirPaths };
}

function isExemptFile(rel) {
  return (
    rel.startsWith("lib/generated/") ||
    rel.startsWith("src/lib/generated/") ||
    /\.(test|spec)\.m?[tj]sx?$/.test(rel) ||
    /\/__tests__\//.test(rel) ||
    /\/tests?\//.test(rel) ||
    /\/__mocks__\//.test(rel)
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

// Strip line + block comments — a comment naming an extension is documentation,
// not runtime coupling.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Scan core for hardcoded extension-instance coupling.
 * Returns { [`<file> :: package :: <name>` | `<file> :: path :: <prefix>`]: count }.
 * Counts ALL non-comment occurrences INCLUDING imports — the src-only
 * import-ban gate does not scan `packages/`, so a package-side import of an
 * extension package would otherwise escape both gates. Path matches are
 * validated against real `extensions/<scope>/<name>` dirs (so a core
 * `@cinatra-ai/extensions/...` package subpath is not a false positive).
 */
export function scanInstanceCoupling(repoRoot = REPO_ROOT, extensions = discoverExtensions(join(repoRoot, "extensions"))) {
  const { names: extensionNames, dirPaths } = extensions;
  const occ = {};
  for (const root of SCAN_ROOTS) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, [])) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (isExemptFile(rel)) continue;
      // Count ALL non-comment references — INCLUDING imports. (The src-only
      // import-ban gate doesn't scan packages/, so import lines must be counted
      // here too or a package-side `import "@scope/ext"` would escape both gates.)
      const code = stripComments(readFileSync(file, "utf8"));
      for (const name of extensionNames) {
        const c = countOccurrences(code, name);
        if (c > 0) occ[`${rel} :: package :: ${name}`] = c;
      }
      EXTENSION_PATH_RE.lastIndex = 0;
      const pathCounts = {};
      let m;
      while ((m = EXTENSION_PATH_RE.exec(code)) !== null) {
        // Only REAL extension dirs — never a core `@cinatra-ai/extensions/...`
        // package subpath that merely contains the substring "extensions/x/y".
        if (dirPaths.has(m[0])) pathCounts[m[0]] = (pathCounts[m[0]] ?? 0) + 1;
      }
      for (const [p, c] of Object.entries(pathCounts)) occ[`${rel} :: path :: ${p}`] = c;
    }
  }
  return occ;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}
function stable(obj) {
  return JSON.stringify({ ...obj, occurrences: sortKeys(obj.occurrences) }, null, 2) + "\n";
}

/** Keys whose CURRENT count exceeds the baseline count, or are entirely new. */
export function diffGrown(baseline, current) {
  const grown = [];
  for (const [k, c] of Object.entries(current)) {
    const base = baseline[k] ?? 0;
    if (c > base) grown.push(`${k} (${base} -> ${c})`);
  }
  return grown.sort();
}
export function diffShrunk(baseline, current) {
  const shrunk = [];
  for (const [k, c] of Object.entries(baseline)) {
    const cur = current[k] ?? 0;
    if (cur < c) shrunk.push(`${k} (${c} -> ${cur})`);
  }
  return shrunk.sort();
}
/** committed baseline must not exceed the base-ref baseline (no regenerate-to-pass). */
export function baselineGrowth(baseBaseline, committed) {
  const grew = [];
  for (const [k, c] of Object.entries(committed)) {
    const base = baseBaseline[k] ?? 0;
    if (c > base) grew.push(`${k} (${base} -> ${c})`);
  }
  return grew.sort();
}

function main() {
  const args = process.argv.slice(2);
  // Fail-closed (source-relocation cutover): without the cloned-back extension tree the
  // instance-coupling scan is empty and this gate passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "core-extension-instance-coupling-ban");
  const current = scanInstanceCoupling();
  const totalFiles = new Set(Object.keys(current).map((k) => k.split(" :: ")[0])).size;
  const totalOcc = Object.values(current).reduce((a, b) => a + b, 0);

  if (args.includes("--write-baseline")) {
    writeFileSync(
      BASELINE_PATH,
      stable({
        note:
          "true-IoC hardcoded-extension-INSTANCE coupling baseline. Each entry is a CURRENT occurrence count of a specific extension package NAME (as a string/JSX/prompt/metadata literal OR an import — the src-only core-extension-import-ban gate does not scan packages/, so imports are counted here too) or an `extensions/<scope>/<name>/` PATH literal in core source. Tolerated until the IoC cutover de-couples it; the count may only ever SHRINK. extensions/ + src/lib/generated/** + tests are exempt. Regenerate with `node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline`.",
        occurrences: current,
      }),
    );
    console.log(`[core-extension-instance-coupling-ban] baseline written — ${totalOcc} occurrence(s) across ${totalFiles} core file(s).`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[core-extension-instance-coupling-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).occurrences ?? {};

  const baseRef = process.env.CORE_EXT_INSTANCE_BAN_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[core-extension-instance-coupling-ban] FAIL — CORE_EXT_INSTANCE_BAN_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
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
        `[core-extension-instance-coupling-ban] FAIL — CORE_EXT_INSTANCE_BAN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/core-extension-instance-coupling-ban.baseline.json`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText).occurrences ?? {}, baseline);
      if (grew.length) {
        console.error(`[core-extension-instance-coupling-ban] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const shrunk = diffShrunk(baseline, current);
  if (shrunk.length) {
    console.log(`[core-extension-instance-coupling-ban] NOTE — ${shrunk.length} coupling(s) reduced (regenerate the baseline via --write-baseline):`);
    shrunk.forEach((e) => console.log("  - " + e));
  }
  const grown = diffGrown(baseline, current);
  if (grown.length) {
    console.error(`[core-extension-instance-coupling-ban] FAIL — ${grown.length} NEW/GROWN hardcoded extension-instance reference(s) in core (route through the manifest/registry, do not name a specific extension):`);
    grown.forEach((e) => console.error("  + " + e));
    process.exit(1);
  }
  console.log(`[core-extension-instance-coupling-ban] OK — no NEW instance coupling. Baseline: ${totalOcc} occurrence(s) across ${totalFiles} file(s) (drive to 0 via the IoC cutover).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
