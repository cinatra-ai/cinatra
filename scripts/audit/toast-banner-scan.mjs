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
// THE LIST MAY NOT GROW (cinatra#3832). The baseline's `entries` are compared with
// the copy of the same file on the base branch (scripts/audit/lib/floor-base-guard.mjs):
// a `file` on the head that the base does not hold fails the run, naming it.
// Removing an entry passes. The baseline holds a list of entries keyed by `file`
// (no counts), so growth is exactly a new key. STATED LIMITS: the comparison is
// mode-blind (it does not read `--enforce`, and it does not look at an entry's
// `class` or `reason`, so changing a class is not growth). The workflow names the
// base from the event itself (TOAST_BANNER_BASE: the pull request's or the merge
// group's base SHA); a merge group run with no such base fails closed; a push
// has no base and passes as such. A baseline file absent on the head has no
// entries to add and is not compared; one absent at a readable base is the
// empty list (an unknown base or a git failure still fails closed). Both sides
// read the list the same way: `entries` absent or `null` is the empty list; any other shape fails closed.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareFloorWithBase, newKeys, reportFloorGuard } from "./lib/floor-base-guard.mjs";
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

/** The variable a workflow may set to name the base revision. */
export const FLOOR_BASE_VAR = "TOAST_BANNER_BASE";

/**
 * A baseline's text -> the list of its entries' `file` names. `entries` absent
 * or `null` is the empty list; a text that is not a JSON object, an `entries`
 * that is not a list, or an entry without a string `file` throws (the message
 * names the field).
 */
export function parseBaselineFiles(text) {
  const doc = JSON.parse(text);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a baseline object");
  const entries = doc.entries ?? [];
  if (!Array.isArray(entries)) throw new Error("entries is not a list");
  return entries.map((e, i) => {
    if (e === null || typeof e !== "object" || typeof e.file !== "string") {
      throw new Error(`entries[${i}].file is not a string`);
    }
    return e.file;
  });
}

/** The floor base guard: the baseline at `baselinePath` may not gain a `file` against the base. */
export function checkFloorAgainstBase({ repoRoot, baselinePath, env = process.env }) {
  const gate = "toast-banner-scan";
  const floorPath = path.relative(repoRoot, baselinePath).split(path.sep).join("/");
  const closed = (status, why) => ({
    status,
    ok: false,
    lines: [`[${gate}] FAIL - the floor ${floorPath} ${why}. Failing closed.`],
  });
  if (floorPath.startsWith("..") || path.isAbsolute(floorPath)) {
    return closed("unreadable", "is outside the package, so it cannot be compared with the base");
  }
  if (!existsSync(baselinePath)) {
    return { status: "no-floor", ok: true, lines: [`[${gate}] floor base guard: no baseline file, so no entry can be added.`] };
  }
  let headFloor;
  try {
    headFloor = parseBaselineFiles(readFileSync(baselinePath, "utf8"));
  } catch (err) {
    return closed("malformed", `is not a readable baseline (${err.message})`);
  }
  // A merge group has no pull request base branch for the shared guard to fall
  // back on: it would pass as "no base". The workflow always names the base.
  if (env.GITHUB_EVENT_NAME === "merge_group" && !env[FLOOR_BASE_VAR]) {
    return closed("unreadable", `cannot be compared with the base: the run is a merge group's but ${FLOOR_BASE_VAR} is empty`);
  }
  const grown = (base, head) => newKeys(base, head).map((f) => `entries file ${f}`);
  const result = compareFloorWithBase({
    gate,
    envVar: FLOOR_BASE_VAR,
    floorPath,
    headFloor,
    parse: parseBaselineFiles,
    grown,
    repoRoot,
    env,
  });
  // The shared guard fails closed on a path that is absent at a readable base
  // as it does on an unreadable base. Here the two differ: a baseline file the
  // base commit does not hold is the EMPTY list (a head that adds the file passes
  // with no entries, and fails naming each entry it adds).
  if (result.status === "unreadable" && result.ref && baseLacksFile(repoRoot, result.ref, floorPath)) {
    const growth = grown([], headFloor);
    const said = `the base "${result.ref}" (which holds no ${floorPath}: an empty list)`;
    if (growth.length === 0) {
      return { status: "held", ok: true, ref: result.ref, growth, lines: [`[${gate}] floor base guard: ${floorPath} does not grow against ${said}.`] };
    }
    return {
      status: "grew",
      ok: false,
      ref: result.ref,
      growth,
      lines: [
        `[${gate}] FAIL - the floor ${floorPath} GREW against ${said} (a floor only shrinks; no pull request raises it in its own change):`,
        ...growth.map((g) => `  + ${g}`),
      ],
    };
  }
  return result;
}

/**
 * True when `ref` is a commit that can be read and its tree holds no `path`.
 * Any other outcome (an unknown commit, a git failure) is false: the base is
 * then unreadable, not empty.
 */
function baseLacksFile(repoRoot, ref, path_) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    const listed = execFileSync("git", ["ls-tree", "--name-only", ref, "--", path_], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return listed.trim() === "";
  } catch {
    return false;
  }
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

  if (!reportFloorGuard(checkFloorAgainstBase({ repoRoot: pkgRoot, baselinePath }))) process.exit(1);

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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
