#!/usr/bin/env node
// Standalone toast-banner conformance scanner — the portable engine behind the
// reusable `toast-banner-gate-reusable.yml` workflow that the S3–S12 connector
// repos adopt (cinatra#1213 AC3). It runs the SAME searchParams-flash-driven
// banner heuristic the core vitest guard runs (both import
// scripts/audit/lib/toast-banner-detect.mjs — no rule is duplicated), but over
// an ARBITRARY package tree checked out at CI time, so a connector repo can
// enforce the invariant without wiring vitest.
//
// Why a connector needs its OWN scan (not core's): a connector repo hosts its
// setup-page source as `src/**/*.tsx` (e.g. a2a-server `src/a2a-server-setup-
// impl.tsx`), NOT core's `src/`+`packages/` layout, and ships no vitest. This
// scanner scans a configurable root inside the checked-out package and compares
// the matches to a per-repo shrink-only baseline.
//
// Baseline (shrink-only ratchet, same semantics as the core guard):
//   - a match NOT in the baseline            → FAIL (new/reintroduced banner);
//   - a baseline entry that no longer matches → FAIL (remove it — the ratchet
//     only shrinks; a migration that toasts a banner drops its baseline entry).
// A MISSING baseline file is treated as an EMPTY baseline (zero-tolerance) so a
// brand-new banner-free connector needs no file to be protected — but the
// connectors adopt an explicit `{"entries":[]}` so a deleted baseline is a
// visible, reviewable diff rather than a silent disable (Codex convergence).
//
// Usage:
//   node scripts/audit/toast-banner-scan.mjs \
//     --package <dir>              # package root to scan (default: ".")
//     --baseline <path>            # baseline JSON (default: <package>/toast-banner-guard.baseline.json)
//     --scan-root <a,b>            # comma-separated roots under the package (default: "src")
//     --enforce <true|false>       # false → report as warnings, exit 0 (default: true)
//
// Exit codes: 0 = clean (or enforce:false with findings); 1 = findings (enforce);
// 2 = operational error (bad args, git failure, malformed baseline).

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBannerFile, isExcludedFromScan, CANONICAL_LAYER_HINT } from "./lib/toast-banner-detect.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`::error::toast-banner-scan: ${msg}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { package: ".", baseline: null, scanRoot: "src", enforce: "true" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) fail(`missing value for ${a}`);
      i += 1;
      return v;
    };
    if (a === "--package") opts.package = next();
    else if (a === "--baseline") opts.baseline = next();
    else if (a === "--scan-root") opts.scanRoot = next();
    else if (a === "--enforce") opts.enforce = next();
    else fail(`unknown argument: ${a}`);
  }
  return opts;
}

const VALID_CLASSES = new Set(["pending-migration", "adjudicated-inline"]);

/** Read + validate the baseline. Missing file → empty (zero-tolerance). */
function loadBaseline(baselinePath) {
  if (!existsSync(baselinePath)) {
    console.log(
      `note: no baseline at ${baselinePath} — treating as empty (zero-tolerance). ` +
        `Commit an explicit {"entries":[]} to make the baseline a reviewable artifact.`,
    );
    return { entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch (e) {
    fail(`baseline ${baselinePath} is not valid JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    fail(`baseline ${baselinePath} must have an "entries" array`);
  }
  const files = parsed.entries.map((e) => e.file);
  if (new Set(files).size !== files.length) fail(`baseline ${baselinePath} has duplicate entries`);
  const sorted = [...files].sort();
  if (JSON.stringify(files) !== JSON.stringify(sorted)) {
    fail(`baseline ${baselinePath} entries must be sorted by file (stable diffs)`);
  }
  for (const e of parsed.entries) {
    if (typeof e.file !== "string" || !e.file) fail(`baseline entry.file must be a non-empty string: ${JSON.stringify(e)}`);
    if (!VALID_CLASSES.has(e.class)) fail(`baseline entry.class must be one of ${[...VALID_CLASSES].join("/")}: ${e.file}`);
    if (typeof e.reason !== "string" || !e.reason.trim()) fail(`baseline entry.reason must be non-empty: ${e.file}`);
  }
  return parsed;
}

// git-index-driven file list (gitignored trees excluded by construction).
//
// The pathspec is the ROOT DIRECTORY (e.g. `src`), NOT a recursive `.tsx`
// glob, then `.tsx` is filtered in JS. This is deliberate: git's default
// pathspec matching does NOT treat a double-star as "zero-or-more path
// components", so a `src`-then-recursive-glob pathspec silently MISSES a file
// directly under the root (`src/setup-page.tsx`,
// `src/a2a-server-setup-impl.tsx`) — precisely the flat layout connector setup
// pages use. A directory pathspec matches every file at any depth, so the guard
// cannot be evaded by putting a banner at the top of `src/`.
function listSourceFiles(pkgRoot, roots) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots],
      { cwd: pkgRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    fail(`git ls-files failed in ${pkgRoot} (is it a git checkout?): ${e.message}`);
  }
  return out
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => p.endsWith(".tsx"))
    .filter((p) => !isExcludedFromScan(p));
}

function scanBannerFiles(pkgRoot, roots) {
  return listSourceFiles(pkgRoot, roots)
    .filter((rel) => isBannerFile(readFileSync(path.join(pkgRoot, rel), "utf8")))
    .sort();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkgRoot = path.resolve(opts.package);
  const roots = opts.scanRoot.split(",").map((s) => s.trim()).filter(Boolean);
  if (roots.length === 0) fail("--scan-root resolved to no roots");
  const baselinePath = opts.baseline
    ? path.resolve(opts.baseline)
    : path.join(pkgRoot, "toast-banner-guard.baseline.json");
  const enforce = opts.enforce !== "false";

  const baseline = loadBaseline(baselinePath);
  const baselineFiles = new Set(baseline.entries.map((e) => e.file));

  const start = performance.now();
  const matches = scanBannerFiles(pkgRoot, roots);
  const elapsedMs = performance.now() - start;

  const introduced = matches.filter((f) => !baselineFiles.has(f));
  const stale = [...baselineFiles].filter((f) => !matches.includes(f)).sort();

  const hint =
    `${CANONICAL_LAYER_HINT} See ${path.relative(pkgRoot, baselinePath)} for any adjudicated inline exemptions.`;

  const problems = [];
  if (introduced.length > 0) {
    problems.push(
      `Found ${introduced.length} NEW searchParams-driven transient banner(s) not on the canonical toast layer:\n` +
        introduced.map((f) => `  - ${f}`).join("\n") +
        `\n\n${hint}`,
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} toast-banner baseline entr${stale.length === 1 ? "y" : "ies"} no longer match — the ratchet only shrinks. ` +
        `Remove the migrated file(s) from ${path.relative(pkgRoot, baselinePath)}:\n` +
        stale.map((f) => `  - ${f}`).join("\n"),
    );
  }

  console.log(
    `toast-banner-scan: scanned ${matches.length + 0} match(es) across roots [${roots.join(", ")}] in ${elapsedMs.toFixed(0)}ms; ` +
      `baseline=${baselineFiles.size} entr${baselineFiles.size === 1 ? "y" : "ies"}.`,
  );

  if (problems.length === 0) {
    console.log("toast-banner-scan: OK — no non-canonical transient banners outside the baseline.");
    process.exit(0);
  }

  const body = problems.join("\n\n");
  if (enforce) {
    console.error(`::error::toast-banner conformance gate failed.\n${body}`);
    process.exit(1);
  }
  console.log(`::warning::toast-banner conformance finding(s) (enforce: false)\n${body}`);
  process.exit(0);
}

main();
