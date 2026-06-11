#!/usr/bin/env node
// True-IoC discovery-dispatcher bypass gate — ZERO-TOLERANCE (cinatra-ai/cinatra#36).
//
// The runtime-discovery dispatcher (`discoverActiveExtensionCapabilities`) is the
// ONE sanctioned way a surface discovers active extension capabilities: it routes
// through the `installed_extension` lifecycle gate and the per-kind visibility
// reader (see docs/developer/extensions.md "Runtime capability discovery"). A
// surface that instead imports a per-kind native discovery reader DIRECTLY
// bypasses the gate — it can show uninstalled capabilities (no lifecycle gate) or
// the wrong actor's rows (no scope).
//
// Since the zero-tolerance flip (#36) the tolerated-bypass BASELINE is pinned EMPTY: any direct
// reference to a gated reader outside the documented SANCTIONED_READERS
// allowlist fails CI immediately, a committed non-empty baseline is itself a
// hard failure, and `--write-baseline` refuses to write a non-empty baseline.
// There is no ratchet left — zero is the floor and the ceiling.
//
// Gated symbol(s): the lifecycle-active agent reader the dispatcher mediates
// AND its archived sibling (an archived-templates read is still a direct
// native-store read; the dispatcher deliberately has no archived/install-state
// surface, so legitimate archived readers are documented in the allowlist).
//
// SANCTIONED_READERS (documented allowlist — never counted): each entry maps a
// repo-relative file to a WRITTEN justification. The gate hard-fails on an
// entry without a justification (structural defect) and on a STALE entry whose
// file no longer references any gated symbol (self-policing — a dormant entry
// could silently re-bless a later reintroduction). Adding an entry requires an
// owner ruling.
//
// Usage:
//   node scripts/audit/discovery-dispatcher-bypass-ban.mjs            # --check (default)
//   node scripts/audit/discovery-dispatcher-bypass-ban.mjs --write-baseline   # refuses non-empty
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
export const GATED_SYMBOLS = ["readActiveExtensionTemplates", "readArchivedExtensionTemplates"];

// Documented sanctioned readers (repo-relative, forward-slash -> written
// justification). The reader's definition, its barrel re-export, the per-kind
// handler facet the dispatcher calls, and the two install-state screens whose
// reads are NOT capability discovery (the dispatcher has no archived /
// install-state surface). Every entry needs a non-empty justification and must
// still reference a gated symbol (stale entries hard-fail). Owner ruling
// required to add an entry.
export const SANCTIONED_READERS = new Map([
  [
    "packages/agents/src/store.ts",
    "defines readActiveExtensionTemplates / readArchivedExtensionTemplates — the reader implementation itself",
  ],
  [
    "packages/agents/src/index.ts",
    "package barrel re-export of the readers (no read of its own)",
  ],
  [
    "packages/agents/src/extension-handler.ts",
    "the dispatcher's sanctioned per-kind agent reader facet — this IS the mediated path's implementation",
  ],
  [
    "packages/extensions/src/screens/extensions-marketplace-screen.tsx",
    "marketplace install-state read model, NOT capability discovery: active+archived templates keyed by packageName to resolve the Install/Update/Installed/Restore CTA; lifecycle (installed_extension) reconciliation happens INSIDE the readers and the read is vendor-scope guarded; the dispatcher has no archived/install-state surface (owner ruling on cinatra-ai/cinatra#36)",
  ],
  [
    "packages/extensions/src/screens/registry-catalog-screen.tsx",
    "routes ACTIVE discovery through discoverActiveExtensionCapabilities (the sanctioned path) and reads ONLY archived templates directly for install-state display — archived templates are not active capabilities and the dispatcher has no archived surface (owner ruling on cinatra-ai/cinatra#36)",
  ],
]);

// Roots scanned: app core + workspace packages (discovery surfaces live in both).
const SCAN_ROOTS = ["src", "packages"];

const SYMBOL_RE = new RegExp(`\\b(?:${GATED_SYMBOLS.join("|")})\\b`);

function isTestFile(rel) {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(rel) ||
    /\/__tests__\//.test(rel) ||
    /\/__mocks__\//.test(rel)
  );
}

function isExemptFile(rel, allowlist = SANCTIONED_READERS) {
  return isTestFile(rel) || allowlist.has(rel);
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

/**
 * Structural defects in the sanctioned-reader allowlist: every entry must
 * carry a non-empty written justification. Returns offending files (empty =
 * OK). Pure + exported for unit testing.
 */
export function sanctionedReaderDefects(allowlist = SANCTIONED_READERS) {
  const bad = [];
  for (const [file, justification] of allowlist) {
    if (typeof justification !== "string" || justification.trim().length === 0) bad.push(file);
  }
  return bad.sort();
}

/**
 * Self-policing staleness: a sanctioned entry whose file no longer references
 * ANY gated symbol must be REMOVED (a dormant entry could silently re-bless a
 * later reintroduction). Returns the stale files (empty = OK).
 */
export function staleSanctionedReaders(repoRoot = REPO_ROOT, allowlist = SANCTIONED_READERS) {
  const stale = [];
  for (const file of allowlist.keys()) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      stale.push(file);
      continue;
    }
    if (!SYMBOL_RE.test(stripComments(readFileSync(abs, "utf8")))) stale.push(file);
  }
  return stale.sort();
}

/** Returns a sorted array of repo-relative files that DIRECTLY reference a gated symbol. */
export function scanBypassFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS, allowlist = SANCTIONED_READERS) {
  const hits = new Set();
  for (const root of roots) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, [])) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (isExemptFile(rel, allowlist)) continue;
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

  // Structural allowlist policy: every sanctioned reader carries a written
  // justification. Fail before scanning — an unjustified entry is a policy
  // violation regardless of the tree's state.
  const defects = sanctionedReaderDefects();
  if (defects.length) {
    console.error(
      `[discovery-dispatcher-bypass-ban] FAIL — SANCTIONED_READERS entr${defects.length === 1 ? "y" : "ies"} without a written justification:`,
    );
    defects.forEach((f) => console.error("  + " + f));
    process.exit(1);
  }

  // Self-policing: a sanctioned entry whose file no longer references a gated
  // reader must be removed, or a later reintroduction would silently ride it.
  const stale = staleSanctionedReaders();
  if (stale.length) {
    console.error(
      `[discovery-dispatcher-bypass-ban] FAIL — STALE SANCTIONED_READERS entr${stale.length === 1 ? "y" : "ies"} (file gone or no longer references a gated reader — remove from the allowlist):`,
    );
    stale.forEach((f) => console.error("  + " + f));
    process.exit(1);
  }

  const current = scanBypassFiles();

  if (args.includes("--write-baseline")) {
    // ZERO-TOLERANCE: the baseline is pinned empty — there is nothing left to
    // tolerate. Refuse to write a non-empty baseline (migrate the surface to
    // the dispatcher, or obtain an owner ruling for a SANCTIONED_READERS
    // entry, instead of re-baselining).
    if (current.length) {
      console.error(
        `[discovery-dispatcher-bypass-ban] FAIL — refusing to write a NON-EMPTY baseline (zero-tolerance: the floor is pinned at zero; migrate to discoverActiveExtensionCapabilities or obtain an owner-ruled SANCTIONED_READERS entry):`,
      );
      current.forEach((f) => console.error("  + " + f));
      process.exit(1);
    }
    const doc = {
      note:
        "True-IoC discovery-dispatcher bypass baseline — PINNED EMPTY by the zero-tolerance flip (cinatra-ai/cinatra#36). Any direct reference to a native discovery reader (GATED_SYMBOLS) outside the documented SANCTIONED_READERS allowlist fails CI immediately; a non-empty committed baseline is itself a failure and --write-baseline refuses to produce one. The sanctioned readers (definition/barrel/dispatcher facet + the two justified install-state screens) live in the gate script, each with a written justification, defect-checked and staleness-self-policed.",
      gatedSymbols: GATED_SYMBOLS,
      files: current,
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    console.log(`[discovery-dispatcher-bypass-ban] baseline written — ${current.length} bypass file(s) (pinned empty).`);
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[discovery-dispatcher-bypass-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).files ?? [];

  // ZERO-TOLERANCE pin: the committed baseline must be EMPTY — a re-populated
  // baseline file is a bypass attempt regardless of the tree's state.
  if (baseline.length) {
    console.error(
      `[discovery-dispatcher-bypass-ban] FAIL — committed baseline is NON-EMPTY (${baseline.length} file(s)); the floor is pinned at zero since the zero-tolerance flip (#36):`,
    );
    baseline.forEach((f) => console.error("  + " + f));
    process.exit(1);
  }

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

  const { added } = diffFiles(baseline, current);
  if (added.length) {
    console.error(
      `[discovery-dispatcher-bypass-ban] FAIL — ${added.length} discovery-dispatcher bypass(es) ` +
        `(ZERO-TOLERANCE: route through discoverActiveExtensionCapabilities, not a direct ${GATED_SYMBOLS.join("/")} reference; sanctioned readers require an owner-ruled, justified SANCTIONED_READERS entry):`,
    );
    added.forEach((f) => console.error("  + " + f));
    process.exit(1);
  }
  console.log(
    `[discovery-dispatcher-bypass-ban] OK — no dispatcher bypass (zero-tolerance holds; baseline pinned empty; ` +
      `${SANCTIONED_READERS.size} documented sanctioned reader(s)).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
