#!/usr/bin/env node
// True-IoC boundary gate — the HOST(core) -> EXTENSION direction.
//
// The merged `extension-import-ban` gate bans extensions importing `@/`. This is
// its mirror: ZERO-TOLERANCE (cinatra-ai/cinatra#36) on cinatra CORE
// (`src/`) importing a named extension package
// (`@cinatra-ai/<x>-{connector,agent,artifact,skill,workflow}`).
// Every such edge is static coupling that makes the system LESS extensible (core
// knows a specific extension by name). The committed baseline is the FROZEN
// RESIDUAL FLOOR of the IoC cutover (epic #24): it may only ever SHRINK, by
// any mechanism — a new edge fails CI, the committed baseline may never grow
// vs the base ref (the one-PR un-exempt seed transition is retired), and
// `--write-baseline` refuses to write a grown baseline.
//
// Exempt (never counted):
//   - the generated manifest tree — the EXPLICIT generator-emitted file list
//     (shared GENERATED_MANIFEST_FILES; the one owner-ruled permanent-exempt
//     class). The generated manifest IS the legitimate data-driven install
//     list (a new entry there is the install set growing, not new
//     hand-coupling); integrity is held by the fail-closed
//     `generate-extension-manifest.mjs --check` CI step, and the list is
//     explicit — a hand-added extra file under src/lib/generated/ is counted.
//   - test/spec files.
//
// CLASSIFICATION (shared taxonomy — scripts/audit/lib/
// extension-reference-classification.mjs, counts published in
// scripts/audit/extension-coupling-gates.md): every baselined edge is
// classified `runtime-coupling` (default) or `mechanical` (facade/inventory/
// dev-list files); both are counted and ratcheted identically. The exempt
// set is UNIFIED with the instance-coupling gate's (same explicit
// generated-file list) since the zero-tolerance flip (#36).
//
// Usage:
//   node scripts/audit/core-extension-import-ban.mjs            # --check (default)
//   node scripts/audit/core-extension-import-ban.mjs --write-baseline
//   CORE_EXT_BAN_BASE=<ref> node ...                            # also fail if baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";
import { classifyFile } from "./lib/extension-reference-classification.mjs";
import { GENERATED_MANIFEST_FILES } from "../extensions/generated-manifest-files.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_PATH = join(__dirname, "core-extension-import-ban.baseline.json");

// No EXEMPT_EXTENSIONS: anthropic-connector is un-exempt — its host->extension
// edges are TRACKED in the baseline like every other connector's. The set is kept
// (empty) so discoverExtensionNames + the scan are unchanged.
const EXEMPT_EXTENSIONS = new Set([]);

// ZERO-TOLERANCE NOTE (#36): the one-PR NEWLY_UNEXEMPTED_BASELINE_SEED transition mechanism
// (which let a just-un-exempted connector's pre-existing edges be seeded into
// the baseline, i.e. the gate's only growth path) is RETIRED — under
// zero-tolerance the committed baseline may never grow vs the base ref, for
// any reason. Un-exempting a connector now requires its host->ext edges to be
// REMOVED in the same PR.
// Capture the BASE package of any @cinatra-ai import (any subpath); membership in
// the derived extension-name set decides if it's an extension. Covers from /
// dynamic import() / require().
const PKG_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](@[a-z0-9-]+\/[a-z0-9-]+)(?:\/[^"']*)?["']/g;

/**
 * The authoritative set of EXTENSION package names — derived from
 * `extensions/<scope>/<name>/package.json` `name` (not a fragile `-kind` suffix
 * heuristic; skill packages are named `*-skills`, etc.).
 */
export function discoverExtensionNames(extRoot = EXTENSIONS_ROOT) {
  const names = new Set();
  if (!existsSync(extRoot)) return names;
  for (const scope of readdirSync(extRoot)) {
    const scopeDir = join(extRoot, scope);
    if (!statSync(scopeDir).isDirectory()) continue;
    for (const pkg of readdirSync(scopeDir)) {
      const manifest = join(scopeDir, pkg, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const name = JSON.parse(readFileSync(manifest, "utf8")).name;
        if (typeof name === "string" && name && !EXEMPT_EXTENSIONS.has(name)) names.add(name);
      } catch {
        /* skip unreadable manifest */
      }
    }
  }
  return names;
}

// The generated-tree exemption is the EXPLICIT generator-emitted file list
// (paths here are src/-relative — this gate scans src/ only), never a
// directory prefix: a hand-added extra file under src/lib/generated/ is
// counted like any other source file (zero-tolerance integrity guard, #36).
const EXEMPT_GENERATED_FILES = new Set(
  GENERATED_MANIFEST_FILES.map((p) => p.replace(/^src\//, "")),
);

function isExemptFile(rel) {
  return (
    EXEMPT_GENERATED_FILES.has(rel) ||
    /\.(test|spec)\.[tj]sx?$/.test(rel) ||
    /\/__tests__\//.test(rel) ||
    /\/__mocks__\//.test(rel)
  );
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(full, acc);
    } else if (/\.(ts|tsx|mts|js|mjs|jsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// Strip line + block comments so commented-out / doc imports don't false-trip.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Returns { [coreFileRelToSrc]: sorted extension package names }. */
export function scanCoreExtensionEdges(srcRoot = SRC_ROOT, extensionNames = discoverExtensionNames()) {
  const files = walk(srcRoot, []);
  const map = {};
  for (const file of files) {
    const rel = relative(srcRoot, file).split("\\").join("/");
    if (isExemptFile(rel)) continue;
    const code = stripComments(readFileSync(file, "utf8"));
    const exts = new Set();
    let m;
    PKG_IMPORT_RE.lastIndex = 0;
    while ((m = PKG_IMPORT_RE.exec(code)) !== null) {
      if (extensionNames.has(m[1])) exts.add(m[1]);
    }
    if (exts.size) map[`src/${rel}`] = [...exts].sort();
  }
  return map;
}

function flatten(map) {
  const set = new Set();
  for (const [file, exts] of Object.entries(map)) for (const e of exts) set.add(`${file} -> ${e}`);
  return set;
}

/**
 * Per-class summary of an edge map (`{ [srcFile]: [extNames] }`) under the
 * shared extension-reference taxonomy. Keys here are already repo-relative
 * (`src/...`). Returns `{ [class]: { files, edges } }`.
 */
export function summarizeEdgeClassification(map) {
  const summary = {
    "runtime-coupling": { files: 0, edges: 0 },
    mechanical: { files: 0, edges: 0 },
  };
  for (const [file, exts] of Object.entries(map)) {
    const cls = classifyFile(file);
    const bucket = summary[cls] ?? summary["runtime-coupling"];
    bucket.files += 1;
    bucket.edges += exts.length;
  }
  return summary;
}

function sortKeysDeep(o) {
  if (Array.isArray(o)) return o.map(sortKeysDeep);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeysDeep(o[k])]));
  }
  return o;
}
function stable(obj) {
  return JSON.stringify(sortKeysDeep(obj), null, 2) + "\n";
}

export function diffEdges(baselineMap, currentMap) {
  const base = flatten(baselineMap);
  const cur = flatten(currentMap);
  const added = [...cur].filter((e) => !base.has(e)).sort();
  const removed = [...base].filter((e) => !cur.has(e)).sort();
  return { added, removed };
}

/**
 * committed baseline must be a STRICT SUBSET of the base-branch baseline (no
 * regenerate-to-pass). Since the zero-tolerance flip (#36) there is NO seed
 * exception — the committed baseline may never grow vs the base ref, for any
 * reason. Pure + exported for unit testing.
 */
export function baselineGrowth(baseBaselineMap, committedBaselineMap) {
  const base = flatten(baseBaselineMap);
  const committed = flatten(committedBaselineMap);
  return [...committed].filter((e) => !base.has(e)).sort();
}

function main() {
  const args = process.argv.slice(2);
  // Fail-closed: without the cloned-back extension tree the
  // banned-name set is empty and this gate passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "core-extension-import-ban");
  const current = scanCoreExtensionEdges();
  const count = flatten(current).size;

  if (args.includes("--write-baseline")) {
    // FAIL-CLOSED write (zero-tolerance, #36): the baseline is the frozen
    // residual floor — regeneration may only ever SHRINK it. Refuse to write
    // any NEW edge vs the committed baseline (remove the new import instead).
    if (existsSync(BASELINE_PATH)) {
      const committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).edges ?? {};
      const grownVsCommitted = baselineGrowth(committed, current);
      if (grownVsCommitted.length) {
        console.error(
          `[core-extension-import-ban] FAIL — refusing to write a GROWN baseline (zero-tolerance: the floor only shrinks; remove the new core->extension import instead of re-baselining it):`,
        );
        grownVsCommitted.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
    const doc = {
      note:
        "True-IoC HOST->EXTENSION import baseline — the FROZEN RESIDUAL FLOOR of the IoC cutover (epic #24), pinned by the zero-tolerance flip (#36). Each entry is a CURRENT core(src/)->extension import edge; every edge is classified runtime-coupling or mechanical under the shared taxonomy (scripts/audit/lib/extension-reference-classification.mjs + scripts/audit/extension-coupling-gates.md). The floor may only ever SHRINK — growth is never sanctioned (the one-PR un-exempt seed transition is retired; --write-baseline refuses grown output). Exempt: ONLY the generated manifest tree (the explicit generator-emitted file list) and tests; anthropic-connector is un-exempt and its host->ext edges are counted here. Regenerate (shrink-only) with `node scripts/audit/core-extension-import-ban.mjs --write-baseline`.",
      classificationSummary: summarizeEdgeClassification(current),
      edges: current,
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    const sum = doc.classificationSummary;
    console.log(
      `[core-extension-import-ban] baseline written — ${count} edges across ${Object.keys(current).length} core files ` +
        `(runtime-coupling: ${sum["runtime-coupling"].edges}, mechanical: ${sum.mechanical.edges}).`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[core-extension-import-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).edges ?? {};

  // Monotonic guard: in CI the committed baseline must be a subset of the base ref's.
  const baseRef = process.env.CORE_EXT_BAN_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[core-extension-import-ban] FAIL — CORE_EXT_BAN_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    // Fail-CLOSED split (mirrors extension-import-ban):
    //  - ref does NOT resolve (shallow checkout / misconfig) → FAIL (a set-but-
    //    unusable base ref must not silently disable the monotonic guard).
    //  - ref resolves but the baseline FILE is absent at it → legitimate
    //    introducing PR → no constraint.
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
        `[core-extension-import-ban] FAIL — CORE_EXT_BAN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/core-extension-import-ban.baseline.json`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const baseEdges = JSON.parse(baseText).edges ?? {};
      const grew = baselineGrowth(baseEdges, baseline);
      if (grew.length) {
        console.error(
          `[core-extension-import-ban] FAIL — committed baseline GREW vs ${baseRef} ` +
            `(zero-tolerance: the frozen floor only shrinks — no regenerate or transition can raise it):`,
        );
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const { added, removed } = diffEdges(baseline, current);
  if (removed.length) {
    console.log(`[core-extension-import-ban] NOTE — ${removed.length} baseline edge(s) decoupled (remove via --write-baseline):`);
    removed.forEach((e) => console.log("  - " + e));
  }
  if (added.length) {
    console.error(
      `[core-extension-import-ban] FAIL — ${added.length} NEW core->extension edge(s) ` +
        `(ZERO-TOLERANCE: route through the generated manifest / runtime-discovery dispatcher, never a named import):`,
    );
    added.forEach((e) => console.error("  + " + e));
    process.exit(1);
  }
  const sum = summarizeEdgeClassification(current);
  console.log(
    `[core-extension-import-ban] OK — no NEW core->extension coupling (zero-tolerance holds). Frozen floor: ${count} edges ` +
      `[runtime-coupling: ${sum["runtime-coupling"].edges} edge(s) / ${sum["runtime-coupling"].files} file(s); ` +
      `mechanical: ${sum.mechanical.edges} edge(s) / ${sum.mechanical.files} file(s)] (the floor only shrinks — see scripts/audit/extension-coupling-gates.md).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
