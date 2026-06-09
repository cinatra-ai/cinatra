#!/usr/bin/env node
// True-IoC boundary gate — the HOST(core) -> EXTENSION direction.
//
// The merged `extension-import-ban` gate bans extensions importing `@/`. This is
// its mirror: a NO-NEW-ROT ratchet on cinatra CORE (`src/`) importing a named
// extension package (`@cinatra-ai/<x>-{connector,agent,artifact,skill,workflow}`).
// Every such edge is static coupling that makes the system LESS extensible (core
// knows a specific extension by name). The IoC cutover drives
// these to zero via the runtime-discovery dispatcher; this gate guarantees the
// boundary can only ever SHRINK in the meantime — a new edge fails CI.
//
// Exempt (never counted):
//   - `src/lib/generated/**` — the generated manifest IS the legitimate
//     data-driven install list (a new entry there is the install set growing,
//     not new hand-coupling).
//   - `@cinatra-ai/anthropic-connector` — stays in-tree (charter: not extracted).
//   - test/spec files.
//
// CLASSIFICATION (shared taxonomy — scripts/audit/lib/
// extension-reference-classification.mjs, counts published in
// scripts/audit/extension-coupling-gates.md): every baselined edge is
// classified `runtime-coupling` (default) or `mechanical` (facade/inventory/
// dev-list files); both are counted and ratcheted identically. NOTE a known,
// documented divergence from the strict exempt set: this gate still
// file-exempts ALL of `src/lib/generated/**` (the instance-coupling gate
// exempts ONLY the manifest and counts the generated derivatives as
// mechanical). Narrowing it here would grow this baseline, which this gate
// forbids — the instance-coupling gate already counts those same files'
// references, so nothing is unmeasured; the exempt sets are unified when
// this baseline is next legitimately recomputed toward 0.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SRC_ROOT = join(REPO_ROOT, "src");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_PATH = join(__dirname, "core-extension-import-ban.baseline.json");

// No EXEMPT_EXTENSIONS: anthropic-connector is un-exempt — its host->extension
// edges are TRACKED in the baseline like every other connector's. The set is kept
// (empty) so discoverExtensionNames + the scan are unchanged.
const EXEMPT_EXTENSIONS = new Set([]);

// One-shot transition for a connector LEAVING EXEMPT_EXTENSIONS: its pre-existing
// host->extension edges are seeded into the baseline in the SAME PR that un-exempts
// it (the edges were always there — just hidden behind the exemption, not new rot).
// `baselineGrowth` allows growth vs the base ref ONLY for edges targeting a member
// here; `staleUnexemptedSeed` forces the member to be removed the moment its edges
// land in the base baseline (one PR only), so it can never silently permit FUTURE
// growth. Adding a member requires the owner un-exempt ruling. The
// anthropic-connector un-exemption edges have already landed in the base baseline,
// so this one-PR transition seed is now empty (the gate fails-closed on a stale seed).
const NEWLY_UNEXEMPTED_BASELINE_SEED = new Set([]);
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

function isExemptFile(rel) {
  return (
    rel.startsWith("lib/generated/") ||
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

/** The target extension of a flattened edge key (`${file} -> ${ext}`). */
function edgeTarget(edge) {
  const idx = edge.lastIndexOf(" -> ");
  return idx >= 0 ? edge.slice(idx + 4) : edge;
}

/**
 * committed baseline must be a SUBSET of the base-branch baseline (no
 * regenerate-to-pass) — EXCEPT edges targeting a NEWLY_UNEXEMPTED_BASELINE_SEED
 * member, which are the pre-existing host->ext edges a just-un-exempted connector
 * seeds ONCE (allowed to grow vs base in THIS PR; self-expiring via
 * staleUnexemptedSeed).
 */
export function baselineGrowth(
  baseBaselineMap,
  committedBaselineMap,
  seed = NEWLY_UNEXEMPTED_BASELINE_SEED,
) {
  const base = flatten(baseBaselineMap);
  const committed = flatten(committedBaselineMap);
  return [...committed]
    .filter((e) => !base.has(e))
    .filter((e) => !seed.has(edgeTarget(e)))
    .sort();
}

/**
 * Self-policing for the un-exempt transition: once a NEWLY_UNEXEMPTED member's
 * host->ext edges are present in the BASE baseline (the seed PR merged), the member
 * is STALE and MUST be removed — otherwise it would silently permit FUTURE host->ext
 * growth to that connector. Returns the stale members (a hard failure in main(),
 * forcing the set to one-PR-only). Pure + exported for unit testing.
 */
export function staleUnexemptedSeed(baseBaselineMap, seed = NEWLY_UNEXEMPTED_BASELINE_SEED) {
  const baseTargets = new Set([...flatten(baseBaselineMap)].map(edgeTarget));
  return [...seed].filter((m) => baseTargets.has(m)).sort();
}

function main() {
  const args = process.argv.slice(2);
  // Fail-closed: without the cloned-back extension tree the
  // banned-name set is empty and this gate passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "core-extension-import-ban");
  const current = scanCoreExtensionEdges();
  const count = flatten(current).size;

  if (args.includes("--write-baseline")) {
    const doc = {
      note:
        "True-IoC HOST->EXTENSION no-new-rot baseline. Each entry is a CURRENT core(src/)->extension import edge tolerated until the IoC cutover removes it via the runtime-discovery dispatcher; every edge is classified runtime-coupling or mechanical under the shared taxonomy (scripts/audit/lib/extension-reference-classification.mjs + scripts/audit/extension-coupling-gates.md). Regenerate with `node scripts/audit/core-extension-import-ban.mjs --write-baseline` (it should only ever SHRINK, except a one-PR NEWLY_UNEXEMPTED_BASELINE_SEED transition). src/lib/generated/** is exempt; anthropic-connector is un-exempt and its host->ext edges are seeded here.",
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
          `[core-extension-import-ban] FAIL — committed baseline GREW vs ${baseRef} (regenerate-to-pass bypass):`,
        );
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
      // Self-policing: the un-exempt seed is one-PR-only. Once a member's host->ext
      // edges are in the base baseline, the seed entry is stale and must be removed.
      const staleSeed = staleUnexemptedSeed(baseEdges);
      if (staleSeed.length) {
        console.error(
          `[core-extension-import-ban] FAIL — NEWLY_UNEXEMPTED_BASELINE_SEED is STALE vs ${baseRef}: ` +
            `its host->ext edges already landed in the base baseline. Remove the member(s) (one-PR-only):`,
        );
        staleSeed.forEach((m) => console.error("  - " + m));
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
    console.error(`[core-extension-import-ban] FAIL — ${added.length} NEW core->extension edge(s) (route through the runtime-discovery dispatcher, not a named import):`);
    added.forEach((e) => console.error("  + " + e));
    process.exit(1);
  }
  const sum = summarizeEdgeClassification(current);
  console.log(
    `[core-extension-import-ban] OK — no NEW core->extension coupling. Baseline: ${count} edges ` +
      `[runtime-coupling: ${sum["runtime-coupling"].edges} edge(s) / ${sum["runtime-coupling"].files} file(s); ` +
      `mechanical: ${sum.mechanical.edges} edge(s) / ${sum.mechanical.files} file(s)] (drive to 0 via the IoC cutover).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
