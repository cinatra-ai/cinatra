#!/usr/bin/env node
// True-IoC structural gate — NO-NEW hardcoded extension-INSTANCE coupling.
//
// The sibling `core-extension-import-ban` gate catches core IMPORTING a specific
// extension package (`import ... from "@cinatra-ai/x-agent"`). This gate catches
// the OTHER way core hardcodes a specific extension INSTANCE: a string literal /
// JSX text / schema description / prompt / package-metadata reference to an exact
// extension package NAME, or an `extensions/<scope>/<name>/` PATH literal — e.g.
// `src/lib/blog/generation.ts`'s `"@cinatra-ai/blog-skills:generate-blog-ideas"` +
// `extensions/cinatra-ai/blog-skills/skills/${slug}/SKILL.md`. That is core
// knowing a specific extension by name, which a true IoC system must not do —
// capabilities come from the manifest/registry, not hardcoded references.
//
// PINNED EMPTY (cinatra#151 Stage 7 — the zero-floor flip, following the
// import-ban / discovery-bypass precedents): the zero-tolerance ratchet
// (cinatra-ai/cinatra#36) drove the baseline from 349 occurrences to EMPTY
// across the cinatra#151 stages (1-6); from the flip onward zero is the floor
// AND the ceiling:
//   - ANY current occurrence fails CI immediately (there is no tolerated set
//     left to diff against);
//   - a NON-EMPTY committed baseline is itself a hard failure;
//   - `--write-baseline` REFUSES to write a non-empty baseline;
//   - the CORE_EXT_INSTANCE_BAN_BASE monotonic guard and the frozen
//     SCANNER_EPOCH survive purely as tamper checks (fail-closed on
//     unresolvable refs / any epoch mismatch).
// The ONLY sanctioned named-extension references are the strict exempt set:
// the generated manifest tree + the documented data-contract-ID allowlist
// (empty; entries are minted only by owner ruling). A scanner fix that
// reveals previously hidden references must land WITH the references removed
// (or owner-ruled into the allowlist) in the same PR — there is no data path
// (baseline, epoch, seed, regenerate) that can raise the floor; only a
// reviewed change to this gate and its tests could alter the semantics.
//
// Counts ALL non-comment occurrences INCLUDING imports — the src-only
// import-ban gate does not scan `packages/`, so a package-side
// `import "@scope/ext"` would otherwise escape both gates. Path matches are
// validated against REAL `extensions/<scope>/<name>` dirs, so a core
// `@cinatra-ai/extensions/...` package subpath is not a false positive.
//
// CLASSIFICATION + STRICT EXEMPT SET (shared taxonomy — see
// scripts/audit/lib/extension-reference-classification.mjs and the published
// counts in scripts/audit/extension-coupling-gates.md):
//   - every counted reference is classified `runtime-coupling` (default) or
//     `mechanical` (facades/inventories/dev-lists/generated derivatives) —
//     BOTH are counted and ratcheted identically;
//   - permanently exempt (never scanned/counted) are ONLY:
//       * the generated manifest tree (PERMANENT_EXEMPT_FILES — the exact
//         generator-emitted files, one owner-ruled class; integrity held by
//         the fail-closed `generate-extension-manifest.mjs --check` CI step,
//         and the list is explicit, so a hand-added file under
//         src/lib/generated/ is still counted),
//       * occurrences inside a documented DATA_CONTRACT_ID_ALLOWLIST entry —
//         each entry carries a written justification and is reported
//         separately + self-policed for staleness,
//       * test / spec / __tests__ / tests / __mocks__ files, and the
//         `extensions/` tree itself (an extension naming ITSELF is fine).
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
import { stripComments } from "./lib/strip-comments.mjs";
import {
  PERMANENT_EXEMPT_FILES,
  DATA_CONTRACT_ID_ALLOWLIST,
  classifyFile,
  allowlistDefects,
  staleAllowlistEntries,
  summarizeByClassification,
} from "./lib/extension-reference-classification.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");
const BASELINE_PATH = join(__dirname, "core-extension-instance-coupling-ban.baseline.json");

// Scanner-correctness epoch — FROZEN at 2 by the zero-tolerance flip (#36).
// The epoch is now purely a TAMPER CHECK (committed baseline epoch must equal
// this constant AND the base ref's epoch); it can no longer sanction baseline
// growth (`growthAllowance` never allows growth — see there). A future
// scanner fix that changes what is counted must land with the revealed
// references REMOVED (or owner-ruled into the data-contract-ID allowlist) in
// the same PR; changing this constant requires editing this gate and its
// tests in a reviewed PR and still cannot un-freeze growth. History:
//   1 — original regex-based comment stripping (mis-lexed `/*` inside line
//       comments / `//` inside strings; HID real references — e.g. the whole
//       static import cluster of src/lib/register-transport-connectors.ts and
//       the live loader map of src/lib/connector-setup-pages.ts).
//   2 — lexical stripper (lib/strip-comments.mjs) + strict exempt set
//       (one-time corrected-baseline recompute, sanctioned before the
//       flip) + the zero-tolerance freeze (#36).
export const SCANNER_EPOCH = 2;

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

// STRICT file exemption: tests + the permanent-exempt set ONLY. The
// permanent-exempt set is the EXPLICIT generator-emitted file list (the one
// owner-ruled generated-tree class — #36) — never a directory prefix, so a
// hand-added extra file under `src/lib/generated/` is still counted.
function isExemptFile(rel) {
  return (
    PERMANENT_EXEMPT_FILES.has(rel) ||
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Printable masking sentinel — deliberately not name-shaped (no `@scope/...`,
// no `extensions/x/y`), space-padded so adjacent tokens cannot fuse.
const ALLOWLIST_SENTINEL = " ALLOWLISTED_DATA_CONTRACT_ID ";

/**
 * Mask EXACT occurrences of the documented data-contract IDs so they are not
 * attributed to their embedded package names. Boundary-anchored on both
 * sides: allowlisting `@scope/x:thing` must NOT also mask the prefix of
 * `@scope/x:thing-v2` (that would hide the longer ID's package name — a
 * ratchet bypass). Returns the masked code; per-ID hit counts are accumulated
 * into `allowlistHits` (a Map) when provided. Exported for unit testing.
 */
export function maskAllowlistedIds(code, allowlist, allowlistHits) {
  let masked = code;
  for (const id of allowlist.keys()) {
    if (!id) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_.:/@-])${escapeRegExp(id)}(?![A-Za-z0-9_.:/@-])`, "g");
    const hits = (masked.match(re) ?? []).length;
    if (hits > 0) {
      if (allowlistHits) allowlistHits.set(id, (allowlistHits.get(id) ?? 0) + hits);
      masked = masked.replace(re, ALLOWLIST_SENTINEL);
    }
  }
  return masked;
}

/**
 * Structural SHAPE defects of the data-contract-ID allowlist (cinatra#151
 * Stage 7 — closes the last data path that could re-grow the pinned-empty
 * floor): an allowlist entry whose masking would hide EXACTLY the coupling
 * shapes this gate bans is rejected outright, justification or not:
 *   - an entry that IS a bare extension package name;
 *   - an entry containing `<extensionName>/` (import-specifier shaped — it
 *     would mask `"@scope/x/register"`-style references);
 *   - an entry containing a REAL `extensions/<scope>/<name>` dir path (it
 *     would mask a path-literal reference).
 * A legitimate contract ID embeds a package name behind a NON-specifier
 * boundary (e.g. `@scope/x-skills:capability-key`). Pure + exported for unit
 * testing. Returns sorted human-readable defect strings.
 */
export function allowlistShapeDefects(allowlist, { names, dirPaths }) {
  const defects = [];
  for (const id of allowlist.keys()) {
    if (!id) continue;
    if (names.has(id)) {
      defects.push(`${id} — IS a bare extension package name (masking it would hide the exact coupling this gate bans)`);
      continue;
    }
    for (const name of names) {
      if (id.includes(`${name}/`)) {
        defects.push(`${id} — import-specifier shaped (contains extension package name ${name} followed by "/")`);
        break;
      }
    }
    for (const p of dirPaths) {
      if (id.includes(p)) {
        defects.push(`${id} — contains the real extension dir path ${p} (masking it would hide a path-literal reference)`);
        break;
      }
    }
  }
  return defects.sort();
}

/**
 * Scan core for hardcoded extension-instance coupling.
 * Returns { [`<file> :: package :: <name>` | `<file> :: path :: <prefix>`]: count }.
 * Counts ALL non-comment occurrences INCLUDING imports — the src-only
 * import-ban gate does not scan `packages/`, so a package-side import of an
 * extension package would otherwise escape both gates. Path matches are
 * validated against real `extensions/<scope>/<name>` dirs (so a core
 * `@cinatra-ai/extensions/...` package subpath is not a false positive).
 *
 * Occurrences inside a documented data-contract-ID allowlist entry are MASKED
 * before counting (they are sanctioned, not baseline); pass `allowlistHits`
 * (a Map) to receive the per-ID hit counts for separate reporting + the
 * staleness self-check.
 */
export function scanInstanceCoupling(
  repoRoot = REPO_ROOT,
  extensions = discoverExtensions(join(repoRoot, "extensions")),
  { allowlist = DATA_CONTRACT_ID_ALLOWLIST, allowlistHits } = {},
) {
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
      // Mask sanctioned data-contract IDs BEFORE counting names, so an EXACT
      // allowlisted ID is never attributed to its embedded package name. Bare
      // (non-ID) occurrences of the same name — and longer IDs that merely
      // share an allowlisted prefix — still count.
      const code = maskAllowlistedIds(stripComments(readFileSync(file, "utf8")), allowlist, allowlistHits);
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

/**
 * Decide whether baseline growth vs the base ref is sanctioned. Since the
 * the zero-tolerance flip (#36) zero-tolerance flip (cinatra-ai/cinatra#36): growth is NEVER
 * sanctioned. The epoch survives purely as a tamper check — the committed
 * baseline's epoch must equal the script's SCANNER_EPOCH AND the base ref's
 * epoch; ANY mismatch (including the formerly sanctioned base+1 advance) is a
 * hard failure. A scanner change that reveals references must land with the
 * references fixed in the same PR — the baseline floor cannot rise by data.
 * Pure + exported for unit testing. Returns { allowGrowth: false, error }.
 */
export function growthAllowance(baseEpoch, committedEpoch, scannerEpoch = SCANNER_EPOCH) {
  if (committedEpoch !== scannerEpoch) {
    return {
      allowGrowth: false,
      error: `committed baseline scannerEpoch=${committedEpoch} does not match the scanner's SCANNER_EPOCH=${scannerEpoch} — regenerate with --write-baseline (shrink-only)`,
    };
  }
  if (committedEpoch !== baseEpoch) {
    return {
      allowGrowth: false,
      error: `committed baseline scannerEpoch=${committedEpoch} vs base scannerEpoch=${baseEpoch} — the epoch is FROZEN since the zero-tolerance flip (#36); an epoch change can no longer sanction baseline growth (fix the revealed references in the same PR instead)`,
    };
  }
  return { allowGrowth: false, error: null };
}

function main() {
  const args = process.argv.slice(2);
  // Fail-closed: without the cloned-back extension tree the
  // instance-coupling scan is empty and this gate passes vacuously.
  assertExtensionsPresent(REPO_ROOT, "core-extension-instance-coupling-ban");

  // Structural allowlist policy: every data-contract-ID entry must carry a
  // written justification. Fail before scanning — an unjustified entry is a
  // policy violation regardless of the tree's state.
  const defects = allowlistDefects();
  if (defects.length) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — DATA_CONTRACT_ID_ALLOWLIST entr${defects.length === 1 ? "y" : "ies"} without a written justification:`,
    );
    defects.forEach((id) => console.error("  + " + id));
    process.exit(1);
  }

  // Structural SHAPE policy (cinatra#151 Stage 7): an allowlist entry whose
  // masking would hide a banned coupling shape (bare package name,
  // import-specifier, real extension dir path) is rejected outright — the
  // allowlist cannot become a data path that re-grows the pinned-empty floor.
  const extensions = discoverExtensions();
  const shapeDefects = allowlistShapeDefects(DATA_CONTRACT_ID_ALLOWLIST, extensions);
  if (shapeDefects.length) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — DATA_CONTRACT_ID_ALLOWLIST entr${shapeDefects.length === 1 ? "y" : "ies"} with a banned SHAPE (a contract ID may embed a package name only behind a non-specifier boundary):`,
    );
    shapeDefects.forEach((d) => console.error("  + " + d));
    process.exit(1);
  }

  const allowlistHits = new Map();
  const current = scanInstanceCoupling(REPO_ROOT, extensions, { allowlistHits });
  const totalFiles = new Set(Object.keys(current).map((k) => k.split(" :: ")[0])).size;
  const totalOcc = Object.values(current).reduce((a, b) => a + b, 0);
  const summary = summarizeByClassification(current);
  const allowlistedOcc = [...allowlistHits.values()].reduce((a, b) => a + b, 0);

  // Self-policing: an allowlist entry whose contract ID no longer occurs
  // anywhere must be removed, or a later reintroduction would silently ride it.
  const stale = staleAllowlistEntries(allowlistHits);
  if (stale.length) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — STALE data-contract-ID allowlist entr${stale.length === 1 ? "y" : "ies"} (ID no longer occurs in scanned source — remove from DATA_CONTRACT_ID_ALLOWLIST):`,
    );
    stale.forEach((id) => console.error("  + " + id));
    process.exit(1);
  }

  if (args.includes("--write-baseline")) {
    // PINNED EMPTY (cinatra#151 Stage 7): there is nothing left to tolerate.
    // Refuse to write a non-empty baseline — remove the named-extension
    // reference instead (route through the manifest/registry/capability
    // path, or — for a genuine stable contract ID — request an owner-ruled
    // DATA_CONTRACT_ID_ALLOWLIST entry).
    if (totalOcc) {
      console.error(
        `[core-extension-instance-coupling-ban] FAIL — refusing to write a NON-EMPTY baseline (the floor is pinned at zero; remove the hardcoded extension-instance reference instead of re-baselining it):`,
      );
      Object.entries(current)
        .map(([k, c]) => `${k} -> ${c}`)
        .sort()
        .forEach((e) => console.error("  + " + e));
      process.exit(1);
    }
    writeFileSync(
      BASELINE_PATH,
      stable({
        note:
          "true-IoC hardcoded-extension-INSTANCE coupling baseline — PINNED EMPTY by the zero-floor flip (cinatra#151 Stage 7; the zero-tolerance ratchet #36 drove the residual floor of the IoC cutover from 349 occurrences to zero across the cinatra#151 stages). Any non-comment occurrence of a specific extension package NAME (string/JSX/prompt/metadata literal OR an import — the src-only core-extension-import-ban gate does not scan packages/, so imports are counted here too) or an `extensions/<scope>/<name>/` PATH literal in core source fails CI immediately; a non-empty committed baseline is itself a failure and --write-baseline refuses to produce one. The ONLY sanctioned named-extension references are the generated manifest tree (the explicit generator-emitted file list), the documented data-contract-ID allowlist (empty; owner-ruled entries only), tests, and the extensions/ tree itself. The scannerEpoch and classificationSummary are retained at their frozen/pinned values as tamper checks and for tooling-shape compatibility.",
        scannerEpoch: SCANNER_EPOCH,
        classificationSummary: summary,
        occurrences: current,
      }),
    );
    console.log(
      `[core-extension-instance-coupling-ban] baseline written — ${totalOcc} occurrence(s) (pinned empty; ` +
        `allowlisted data-contract IDs reported separately: ${allowlistedOcc}).`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[core-extension-instance-coupling-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baselineDoc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const baseline = baselineDoc.occurrences ?? {};
  const committedEpoch = baselineDoc.scannerEpoch ?? 1;

  // PINNED-EMPTY pin (cinatra#151 Stage 7): the committed baseline must be
  // EMPTY — a re-populated baseline file is a bypass attempt regardless of
  // the tree's state.
  const committedKeys = Object.keys(baseline);
  if (committedKeys.length) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — committed baseline is NON-EMPTY (${committedKeys.length} key(s)); the floor is pinned at zero since the zero-floor flip (cinatra#151 Stage 7):`,
    );
    committedKeys.sort().forEach((k) => console.error(`  + ${k} -> ${baseline[k]}`));
    process.exit(1);
  }

  if (committedEpoch !== SCANNER_EPOCH) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — committed baseline scannerEpoch=${committedEpoch} does not match SCANNER_EPOCH=${SCANNER_EPOCH}. ` +
        `The scanner changed what it counts; regenerate the baseline with --write-baseline (and land it WITH the scanner change).`,
    );
    process.exit(1);
  }

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
      const baseDoc = JSON.parse(baseText);
      const baseEpoch = baseDoc.scannerEpoch ?? 1;
      // the zero-tolerance flip (#36): growthAllowance NEVER allows growth — it is purely the epoch
      // tamper check now (any epoch mismatch is a hard failure).
      const { error } = growthAllowance(baseEpoch, committedEpoch);
      if (error) {
        console.error(`[core-extension-instance-coupling-ban] FAIL — ${error}.`);
        process.exit(1);
      }
      const grew = baselineGrowth(baseDoc.occurrences ?? {}, baseline);
      if (grew.length) {
        console.error(
          `[core-extension-instance-coupling-ban] FAIL — committed baseline GREW vs ${baseRef} ` +
            `(zero-tolerance: the frozen floor only shrinks — no recompute, epoch bump, or regenerate can raise it):`,
        );
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  // PINNED EMPTY: any current occurrence fails immediately (zero is the
  // floor and the ceiling — there is no tolerated set left to diff against).
  if (totalOcc) {
    console.error(
      `[core-extension-instance-coupling-ban] FAIL — ${totalOcc} hardcoded extension-instance reference(s) across ${totalFiles} core file(s) ` +
        `(PINNED EMPTY: the only sanctioned named-extension references are the generated manifest tree and the documented ` +
        `data-contract-ID allowlist — route through the manifest/registry/capability path, never name a specific extension):`,
    );
    Object.entries(current)
      .map(([k, c]) => `${k} -> ${c}`)
      .sort()
      .forEach((e) => console.error("  + " + e));
    process.exit(1);
  }
  console.log(
    `[core-extension-instance-coupling-ban] OK — zero hardcoded extension-instance references (baseline PINNED EMPTY since the zero-floor flip, cinatra#151 Stage 7) ` +
      `[data-contract allowlisted (sanctioned, not counted): ${allowlistedOcc}] ` +
      `(exempt set: generated manifest tree + documented data-contract-ID allowlist ONLY — see scripts/audit/extension-coupling-gates.md).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
