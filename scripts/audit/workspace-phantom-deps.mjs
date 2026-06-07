#!/usr/bin/env node
/**
 * Workspace phantom-dependency gate (no-new-rot ratchet).
 *
 * A "phantom dependency" is a source import of a first-party WORKSPACE package
 * (e.g. `@cinatra-ai/llm`) from a package whose own `package.json` does NOT
 * declare that package in any dependency bucket. It resolves today only via
 * pnpm's hoisted `node_modules` + tsconfig path aliases, so it is invisible to
 * `tsgo`/`next build` — but breaks under isolated `node_modules`, a clean
 * `pnpm install --frozen-lockfile` (the CI default), or extraction of the
 * package to its own repo. No existing gate catches this class (the import-ban /
 * instance-coupling / dispatcher gates target core<->extension *coupling*, not
 * dependency *completeness*; `scripts/extensions/inventory.mjs --check` is non-failing).
 *
 * The gate enumerates every pnpm workspace member, scans its non-test source for
 * imports of OTHER workspace members, and flags any that are undeclared. It is a
 * monotonic ratchet: a JSON baseline records the CURRENT (tolerated) misses; the
 * gate fails only on NEW or GROWN misses. Regenerate (it should only ever
 * SHRINK) with `--write-baseline`.
 *
 * Exit codes: 0 = clean (no new phantom deps), 1 = findings, 2 = scanner error.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.cwd();
const WORKSPACE_FILE = join(REPO_ROOT, "pnpm-workspace.yaml");
const BASELINE_FILE = join(REPO_ROOT, "scripts/audit/workspace-phantom-deps.baseline.json");

const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo", ".git"]);
const TEST_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)tests?\//;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/workspace-phantom-deps.test.mjs)
// ---------------------------------------------------------------------------

/** Parse the `packages:` glob list out of pnpm-workspace.yaml (no YAML dep). */
export function parseWorkspaceGlobs(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const globs = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages && /^\S/.test(line)) break; // next top-level key
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (m) globs.push(m[1].trim());
  }
  return globs;
}

/** Map an import specifier to its owning package name, or null for relative /
 * builtin / non-package specifiers. `@scope/name/sub` -> `@scope/name`; for
 * unscoped, `name/sub` -> `name`. */
export function resolveSpecifierToPackage(spec) {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return null;
  if (spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0];
}

/** Extract the set of OTHER-workspace package names imported by `source`.
 * Covers `from "x"`, side-effect `import "x"`, `import("x")`, `require("x")`,
 * and `export ... from "x"`. `internalNames` is the Set of workspace member
 * names; `selfName` is excluded. */
export function extractInternalImports(source, internalNames, selfName) {
  const found = new Set();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,            // import/export ... from "x"
    /\bimport\s*\(\s*["']([^"']+)["']/g,      // dynamic import("x")
    /\brequire\s*\(\s*["']([^"']+)["']/g,     // require("x")
    /\bimport\s+["']([^"']+)["']/g,           // side-effect import "x"
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      const pkg = resolveSpecifierToPackage(m[1]);
      if (pkg && pkg !== selfName && internalNames.has(pkg)) found.add(pkg);
    }
  }
  return found;
}

/** Compare findings against a baseline. Returns { newViolations: {pkg:[deps]} }.
 * A (pkg, dep) pair is a NEW violation iff it is not present in the baseline. */
export function diffAgainstBaseline(findings, baseline) {
  const baseMap = baseline?.phantomDeps ?? {};
  const newViolations = {};
  for (const [pkg, deps] of Object.entries(findings)) {
    const known = new Set(baseMap[pkg] ?? []);
    const fresh = deps.filter((d) => !known.has(d));
    if (fresh.length) newViolations[pkg] = fresh.sort();
  }
  return { newViolations };
}

/** Base-ref ratchet: (pkg, dep) pairs in the COMMITTED baseline that are ABSENT
 * from the BASE-branch baseline — i.e. a regenerate-to-pass bypass that added
 * new tolerated misses in the same PR. Mirrors the sibling no-new-rot gates so
 * the baseline can only ever SHRINK. */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const basePairs = new Set();
  for (const [pkg, deps] of Object.entries(baseBaseline?.phantomDeps ?? {})) for (const d of deps) basePairs.add(`${pkg} :: ${d}`);
  const grew = [];
  for (const [pkg, deps] of Object.entries(committedBaseline?.phantomDeps ?? {})) for (const d of deps) {
    const key = `${pkg} :: ${d}`;
    if (!basePairs.has(key)) grew.push(key);
  }
  return grew.sort();
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

function expandGlob(pattern) {
  // One-level-per-segment glob: supports `*` (and prefix*/*-suffix) within a
  // single path segment; no `**`. Returns existing directories.
  const segs = pattern.split("/");
  let dirs = [REPO_ROOT];
  for (const seg of segs) {
    const next = [];
    const hasWild = seg.includes("*");
    const re = hasWild ? new RegExp("^" + seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    for (const d of dirs) {
      if (!hasWild) { const p = join(d, seg); if (existsSync(p) && statSync(p).isDirectory()) next.push(p); continue; }
      let entries;
      try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isDirectory() && re.test(e.name)) next.push(join(d, e.name));
    }
    dirs = next;
  }
  return dirs;
}

function readPackage(dir) {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    if (!pkg.name) return null;
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    return { name: pkg.name, dir, declared };
  } catch { return null; }
}

function* walkSource(root) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkSource(join(root, e.name));
    } else if (e.isFile()) {
      const dot = e.name.lastIndexOf(".");
      if (dot >= 0 && SOURCE_EXT.has(e.name.slice(dot))) yield join(root, e.name);
    }
  }
}

/** Discover workspace members (the extractable/publishable packages matched by
 * the pnpm-workspace globs). The ROOT app (`.`) is intentionally excluded — both
 * as an importer AND from the internal-name set: it consumes workspace packages
 * via Next.js `transpilePackages` + tsconfig `paths`, not package.json
 * `dependencies`, and is deployed as a standalone build (never installed or
 * extracted as an npm package), so an undeclared `@cinatra-ai/*` import in its
 * `src/` is not the frozen-install / extraction breakage class this gate guards.
 * No published package depends on the app, so omitting it loses no signal. */
function discoverMembers() {
  const globs = parseWorkspaceGlobs(readFileSync(WORKSPACE_FILE, "utf8"));
  const byDir = new Map();
  for (const g of globs) for (const dir of expandGlob(g)) {
    const pkg = readPackage(dir);
    if (pkg) byDir.set(dir, pkg);
  }
  return [...byDir.values()];
}

function scan() {
  const members = discoverMembers();
  const internalNames = new Set(members.map((m) => m.name));
  const findings = {};
  for (const m of members) {
    const scanRoot = m.scanRoot ?? m.dir;
    if (!existsSync(scanRoot)) continue;
    const missing = new Set();
    for (const file of walkSource(scanRoot)) {
      if (TEST_RE.test(relative(REPO_ROOT, file))) continue;
      const imported = extractInternalImports(readFileSync(file, "utf8"), internalNames, m.name);
      for (const dep of imported) if (!m.declared.has(dep)) missing.add(dep);
    }
    if (missing.size) findings[m.name] = [...missing].sort();
  }
  return { findings, memberCount: members.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");
  let result;
  try { result = scan(); } catch (err) {
    console.error(`[workspace-phantom-deps] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }
  const { findings, memberCount } = result;
  const totalPairs = Object.values(findings).reduce((n, a) => n + a.length, 0);

  if (write) {
    const baseline = {
      note: "Workspace phantom-dependency baseline (no-new-rot ratchet). Each entry = a source import of a first-party workspace package NOT declared in the importing package's package.json (resolves only via pnpm hoisting). These are CURRENT tolerated misses; the gate fails on NEW/GROWN entries. Regenerate with `node scripts/audit/workspace-phantom-deps.mjs --write-baseline` — every entry should only ever be REMOVED (declare the dep), never added.",
      phantomDeps: findings,
    };
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    console.log(`[workspace-phantom-deps] wrote baseline: ${Object.keys(findings).length} packages / ${totalPairs} phantom deps (scanned ${memberCount} members).`);
    return;
  }

  if (report) {
    console.log(`[workspace-phantom-deps] ${memberCount} members scanned; ${totalPairs} phantom deps across ${Object.keys(findings).length} packages:`);
    for (const [pkg, deps] of Object.entries(findings).sort()) console.log(`  ${pkg}\n    - ${deps.join("\n    - ")}`);
    return;
  }

  const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : { phantomDeps: {} };

  // Base-ref ratchet: block the regenerate-to-pass bypass (adding a phantom
  // import + `--write-baseline` in the same PR). When WORKSPACE_PHANTOM_DEPS_BASE
  // is set (wired from the CI base ref), fail if the committed baseline contains
  // any (pkg, dep) pair absent from the base-branch baseline. Mirrors the
  // sibling no-new-rot gates; fail-closed if the ref can't be resolved.
  const baseRef = process.env.WORKSPACE_PHANTOM_DEPS_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[workspace-phantom-deps] FAIL — WORKSPACE_PHANTOM_DEPS_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch { refResolves = false; }
    if (!refResolves) {
      console.error(`[workspace-phantom-deps] FAIL — WORKSPACE_PHANTOM_DEPS_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/workspace-phantom-deps.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(`[workspace-phantom-deps] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`);
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const { newViolations } = diffAgainstBaseline(findings, baseline);
  const newCount = Object.values(newViolations).reduce((n, a) => n + a.length, 0);

  if (newCount === 0) {
    console.log(`[workspace-phantom-deps] OK — no new phantom deps (scanned ${memberCount} members; ${totalPairs} baselined).`);
    process.exit(0);
  }
  console.error(`[workspace-phantom-deps] FAIL — ${newCount} NEW phantom dependenc${newCount === 1 ? "y" : "ies"}:`);
  for (const [pkg, deps] of Object.entries(newViolations)) {
    console.error(`  ${pkg} imports but does not declare:`);
    for (const d of deps) console.error(`    - ${d}  (add "${d}": "workspace:*" to ${pkg}'s package.json, then run pnpm install)`);
  }
  console.error(`\nIf this is intentional debt, regenerate the baseline with --write-baseline (it should only ever shrink).`);
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
