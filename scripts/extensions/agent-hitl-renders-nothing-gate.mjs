#!/usr/bin/env node
/**
 * Agent-HITL renders-nothing ratchet gate (cinatra#3470, epic cinatra#2926).
 *
 * THE RULE this gate makes deterministic in the product's build:
 *
 *   Connectors render the setup page themselves.
 *   Artifacts render the artifact view themselves.
 *   Agents do NOT render the HITL view themselves.
 *
 * The third clause has no enforcement today. The optional
 * `cinatra.fieldRenderers[].component` declaration (cinatra#1625, the S8/M3 road
 * of epic #1620) lets a claiming extension ship the React component the host
 * mounts for a binding id — a channel epic #1620 meant for `kind:"artifact"`
 * packages, but which the manifest validator accepts from ANY kind. Four
 * `kind:"agent"` packages took it, and three of them additionally vendor
 * design-registry primitives (src/components/ui/*.tsx) to draw with. Nothing
 * stops a fifth.
 *
 * This gate is the GUARDRAIL: it pins TODAY's agent-side drawing as a baseline
 * and fails CI on any addition. It forces NO migration (the baseline is set at
 * current state); it only prevents agent-side rendering from growing, and the
 * baseline ratchets DOWN as #3470's migration relocates each renderer out of its
 * agent package. Same fail-closed, shrink-only shape as
 * scripts/audit/file-size-ratchet.mjs.
 *
 * What it reads: the SYNCED extension tree (extensions/<scope>/<pkg>/package.json
 * + <pkg>/src/components/ui/) — run it in a job that has the cloned-back tree,
 * beside `generate-extension-manifest.mjs --check`.
 *
 * Ratchet semantics:
 *  - A `kind:"agent"` package declaring `cinatra.fieldRenderers[].component` for
 *    a binding id NOT in the baseline -> FAIL.
 *  - A `kind:"agent"` package carrying a vendored design-registry primitive
 *    (a file under its src/components/ui/) NOT in the baseline -> FAIL.
 *  - A `kind:"agent"` package listed in the vendoring manifest
 *    (scripts/extensions/vendor-extension-primitives.mjs VENDOR_MANIFEST) and
 *    NOT in the baseline -> FAIL.
 *  - A baseline pair that no longer exists -> FAIL (shrink-only: the baseline may
 *    only ever get SHORTER; a stale entry would keep a retired allowance alive
 *    and hide the win, exactly as file-size-ratchet fails on a tracked file that
 *    vanished).
 *  - `kind:"connector"` and `kind:"artifact"` packages are NOT subject to any of
 *    it — they DO render their own surfaces; the rule is agent-only.
 *
 * Node-builtins-only + offline. No third-party dependency.
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = scanner error.
 *
 * Usage:
 *   node scripts/extensions/agent-hitl-renders-nothing-gate.mjs                  # gate (CI)
 *   node scripts/extensions/agent-hitl-renders-nothing-gate.mjs --report         # what is allowed today
 *   node scripts/extensions/agent-hitl-renders-nothing-gate.mjs --write-baseline  # (re)write the baseline from the live tree
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { VENDOR_MANIFEST } from "./vendor-extension-primitives.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

export const BASELINE_FILE = join(REPO_ROOT, "scripts/extensions/agent-hitl-renders-nothing.baseline.json");
export const EXTENSIONS_DIR = "extensions";

/** The sentence the gate speaks, and the issue that owns it. */
export const RULE_SENTENCE =
  "Connectors render the setup page themselves. Artifacts render the artifact view themselves. Agents do NOT render the HITL view themselves.";
export const RULE_ISSUE = "cinatra#3470";

/**
 * The host's extension-kind vocabulary (scripts/extensions/inventory.mjs).
 * The rule is agent-only, so a package whose `cinatra.kind` is MISSING or
 * outside this vocabulary would slip past the whole ratchet by typo alone —
 * the gate refuses to run on such a tree instead of reading it as "not an
 * agent, nothing to check".
 */
export const KNOWN_EXTENSION_KINDS = new Set(["agent", "connector", "artifact", "skill", "workflow"]);

/**
 * Base-ref arm (mirrors WORKSPACE_FILE_SIZE_RATCHET_BASE in
 * scripts/audit/file-size-ratchet.mjs): when set, the committed baseline is
 * compared against the base branch's copy and ANY added pair fails — the
 * shrink-only promise is otherwise defeated by `--write-baseline` in the same
 * change (add a renderer, regenerate, both arms go green).
 */
export const BASE_ENV_VAR = "AGENT_HITL_RENDERS_NOTHING_BASE";

/** Where an extension's vendored design-registry primitives land. */
const UI_SUBDIR = "src/components/ui";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in __tests__/agent-hitl-renders-nothing-gate.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Scan a synced extension tree into the shape the ratchet compares.
 * `root` is the repo-root-relative (or absolute — a test fixture tree) extensions
 * directory; `extensionDir` on each record is built from `root` as given, so the
 * real scan yields the repo-relative dirs the vendoring manifest names.
 * Returns a sorted array of
 * `{ packageName, extensionDir, kind, componentBindingIds[], vendoredFiles[] }`
 * for EVERY package found (all kinds — the kind filter lives in `evaluate`, so
 * a connector/artifact case is visible to the report and to the tests).
 */
function listFilesRecursive(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export function scanExtensionTree(root) {
  const abs = isAbsolute(root) ? root : join(REPO_ROOT, root);
  const found = [];
  for (const scope of readdirSync(abs).sort()) {
    const scopeDir = join(abs, scope);
    if (!statSync(scopeDir).isDirectory()) continue;
    for (const pkgDir of readdirSync(scopeDir).sort()) {
      const pkgPath = join(scopeDir, pkgDir, "package.json");
      if (!existsSync(pkgPath)) continue;
      // FAIL-CLOSED: an unreadable manifest is not "nothing to check" — a
      // silent skip would let a malformed agent package draw whatever it likes.
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(pkgPath, "utf8"));
      } catch (err) {
        throw new Error(`unreadable extension manifest ${pkgPath}: ${err?.message ?? err}`);
      }
      const packageName = typeof manifest.name === "string" ? manifest.name : null;
      if (!packageName) throw new Error(`extension manifest without a name: ${pkgPath}`);
      const cin = manifest.cinatra ?? {};
      const declared = Array.isArray(cin.fieldRenderers) ? cin.fieldRenderers : [];
      const componentBindingIds = declared
        .filter((e) => e && typeof e === "object" && e.component !== undefined && typeof e.id === "string")
        .map((e) => e.id)
        .sort();
      // EVERY file under src/components/ui, at ANY depth and with ANY
      // extension: a vendored primitive added as `card.ts`, `card.jsx` or
      // `nested/card.tsx` draws just as well as `card.tsx`, and a DIRECTORY
      // named `card.tsx` is not a primitive at all.
      const uiDir = join(scopeDir, pkgDir, UI_SUBDIR);
      const vendoredFiles =
        existsSync(uiDir) && statSync(uiDir).isDirectory()
          ? listFilesRecursive(uiDir).map((f) => `${UI_SUBDIR}/${f}`)
          : [];
      found.push({
        packageName,
        extensionDir: `${root}/${scope}/${pkgDir}`,
        kind: typeof cin.kind === "string" ? cin.kind : null,
        componentBindingIds,
        vendoredFiles,
      });
    }
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

/** The `extensionDir` set the vendoring manifest claims. */
export function vendoringManifestDirs(manifest = VENDOR_MANIFEST) {
  return new Set(manifest.map((e) => e.extensionDir));
}

function listOf(section, packageName) {
  const raw = section?.[packageName];
  return Array.isArray(raw) ? raw : [];
}

/**
 * The exact (package, binding id) pairs the baseline allows, as a flat array of
 * binding ids for ONE package. The manifest validator's agent refusal consumes
 * this (it is fs-free, so the caller supplies the list).
 */
export function baselinedComponentBindingIds(baseline, packageName) {
  return listOf(baseline?.componentBindings, packageName);
}

/**
 * Compare a scanned tree against the baseline.
 *
 * Returns `{ violations, stale }`:
 *  - `violations` — agent-side drawing that is NOT baselined, each
 *    `{ kind: "component-binding" | "vendored-primitive" | "vendoring-manifest-entry",
 *       packageName, detail }`;
 *  - `stale` — baseline pairs that no longer exist (the shrink-only arm), same shape.
 */
export function evaluate(packages, baseline, vendorDirs = vendoringManifestDirs()) {
  const violations = [];
  const stale = [];
  const byName = new Map(packages.map((p) => [p.packageName, p]));

  for (const pkg of packages) {
    if (pkg.kind !== "agent") continue; // the rule is agent-only
    const allowedBindings = new Set(baselinedComponentBindingIds(baseline, pkg.packageName));
    for (const id of pkg.componentBindingIds) {
      if (!allowedBindings.has(id)) {
        violations.push({ kind: "component-binding", packageName: pkg.packageName, detail: id });
      }
    }
    const allowedFiles = new Set(listOf(baseline?.vendoredPrimitives, pkg.packageName));
    for (const file of pkg.vendoredFiles) {
      if (!allowedFiles.has(file)) {
        violations.push({ kind: "vendored-primitive", packageName: pkg.packageName, detail: file });
      }
    }
    if (vendorDirs.has(pkg.extensionDir)) {
      const allowedEntry = listOf(baseline?.vendoringManifestEntries, pkg.packageName);
      if (!allowedEntry.includes(pkg.extensionDir)) {
        violations.push({
          kind: "vendoring-manifest-entry",
          packageName: pkg.packageName,
          detail: pkg.extensionDir,
        });
      }
    }
  }

  // Shrink-only arm: every baselined pair must still exist on an agent package.
  const staleFor = (sectionName, kind, present) => {
    const section = baseline?.[sectionName] ?? {};
    for (const packageName of Object.keys(section).sort()) {
      const pkg = byName.get(packageName);
      for (const detail of listOf(section, packageName)) {
        if (!pkg || pkg.kind !== "agent" || !present(pkg, detail)) {
          stale.push({ kind, packageName, detail });
        }
      }
    }
  };
  staleFor("componentBindings", "component-binding", (pkg, id) => pkg.componentBindingIds.includes(id));
  staleFor("vendoredPrimitives", "vendored-primitive", (pkg, file) => pkg.vendoredFiles.includes(file));
  staleFor("vendoringManifestEntries", "vendoring-manifest-entry", (pkg, dir) =>
    vendorDirs.has(dir) && pkg.extensionDir === dir,
  );

  const order = (a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.packageName.localeCompare(b.packageName) ||
    a.detail.localeCompare(b.detail);
  return { violations: violations.sort(order), stale: stale.sort(order) };
}

/** Build a baseline object from a scanned tree (every agent-side pair present today). */
export function baselineFromTree(packages, vendorDirs = vendoringManifestDirs()) {
  const componentBindings = {};
  const vendoredPrimitives = {};
  const vendoringManifestEntries = {};
  for (const pkg of packages) {
    if (pkg.kind !== "agent") continue;
    if (pkg.componentBindingIds.length) componentBindings[pkg.packageName] = [...pkg.componentBindingIds];
    if (pkg.vendoredFiles.length) vendoredPrimitives[pkg.packageName] = [...pkg.vendoredFiles];
    if (vendorDirs.has(pkg.extensionDir)) vendoringManifestEntries[pkg.packageName] = [pkg.extensionDir];
  }
  return {
    note:
      `Agent-HITL renders-nothing ratchet baseline (${RULE_ISSUE}). ${RULE_SENTENCE} ` +
      "Each entry is a (package, binding id) / (package, vendored file) / (package, vendoring-manifest entry) pair that ALREADY draws from inside a kind:\"agent\" package. " +
      "The gate fails on any agent-side drawing NOT listed here, and on any entry listed here that no longer exists: this list may only ever get SHORTER, never longer. " +
      "Regenerate with `node scripts/extensions/agent-hitl-renders-nothing-gate.mjs --write-baseline` only to record a SHRINK.",
    componentBindings,
    vendoredPrimitives,
    vendoringManifestEntries,
  };
}

/** Read the committed baseline (an absent file is an empty baseline: nothing allowed). */
export function loadBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) return { componentBindings: {}, vendoredPrimitives: {}, vendoringManifestEntries: {} };
  return assertBaselineShape(JSON.parse(readFileSync(file, "utf8")), file);
}

/**
 * FAIL-CLOSED baseline contract. A section that is not a package -> string[]
 * map would be read as "allows nothing" by `listOf` — which silently disables
 * the stale (shrink-only) arm for that package instead of failing.
 */
export function assertBaselineShape(baseline, file = BASELINE_FILE) {
  const bad = (msg) => {
    throw new Error(`malformed baseline ${file}: ${msg}`);
  };
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) bad("not a JSON object");
  for (const section of ["componentBindings", "vendoredPrimitives", "vendoringManifestEntries"]) {
    const entries = baseline[section];
    if (entries === undefined) bad(`missing section "${section}"`);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) bad(`section "${section}" is not an object`);
    for (const [packageName, list] of Object.entries(entries)) {
      if (!Array.isArray(list)) bad(`${section}."${packageName}" is not an array`);
      if (!list.every((d) => typeof d === "string")) bad(`${section}."${packageName}" holds a non-string entry`);
    }
  }
  return baseline;
}

/**
 * The baselined binding ids for ONE package, read from the committed baseline.
 * The generator passes this into the shared manifest validator so a NEW
 * `component` on a kind:"agent" binding is red at
 * `generate-extension-manifest.mjs --check` too, not only in this gate.
 * Memoized — the generator calls it once per extension record.
 */
let baselineCache;
export function baselinedComponentBindingIdsFor(packageName, file = BASELINE_FILE) {
  if (baselineCache === undefined || baselineCache.file !== file) {
    baselineCache = { file, baseline: loadBaseline(file) };
  }
  // A COPY: the generator must not be able to mutate the memoized baseline.
  return [...baselinedComponentBindingIds(baselineCache.baseline, packageName)];
}

/**
 * Packages the kind filter cannot classify (missing or unknown `cinatra.kind`).
 * Such a package is neither checked nor exempt on purpose — the gate refuses.
 */
export function unknownKindPackages(packages) {
  return packages.filter((p) => !p.kind || !KNOWN_EXTENSION_KINDS.has(p.kind)).map((p) => p.packageName);
}

/** Every pair the baseline allows, flattened to comparable `section|package|detail` strings. */
export function baselinePairs(baseline) {
  const pairs = [];
  for (const section of ["componentBindings", "vendoredPrimitives", "vendoringManifestEntries"]) {
    const entries = baseline?.[section] ?? {};
    for (const packageName of Object.keys(entries).sort()) {
      for (const detail of listOf(entries, packageName)) pairs.push(`${section}|${packageName}|${detail}`);
    }
  }
  return pairs.sort();
}

/**
 * Pairs present in `committed` that the `base` baseline does not carry — the
 * regenerate-to-pass bypass. Shrink-only means this is ALWAYS empty; a swap
 * (one pair removed, another added) is growth too, which a count check misses.
 */
export function baselineGrowth(base, committed) {
  const had = new Set(baselinePairs(base));
  return baselinePairs(committed).filter((p) => !had.has(p));
}

/**
 * A tree the gate must not read as clean: no package at all, or no `kind:"agent"`
 * package while the baseline still records agent-side drawing (a job that runs
 * the gate without the cloned-back extension tree, or a half-synced one).
 */
export function incompleteTreeError(packages, baseline) {
  if (packages.length === 0) return "scanned 0 extension packages — the extension tree is absent or not cloned back";
  const agents = packages.filter((p) => p.kind === "agent").length;
  if (agents === 0 && baselinePairs(baseline).length > 0) {
    return 'scanned 0 kind:"agent" packages while the baseline still records agent-side drawing — the extension tree is incomplete';
  }
  return null;
}

/** The human line for one finding. */
export function formatFinding(f) {
  const what = {
    "component-binding": "field-renderer component on binding",
    "vendored-primitive": "vendored design-registry primitive",
    "vendoring-manifest-entry": "vendoring-manifest entry",
  }[f.kind];
  return `  ${f.packageName}: ${what} ${f.detail}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write-baseline");
  const report = args.includes("--report");

  let packages;
  try {
    packages = scanExtensionTree(EXTENSIONS_DIR);
  } catch (err) {
    console.error(`[agent-hitl-renders-nothing] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }

  if (write) {
    const baseline = baselineFromTree(packages);
    writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
    const pairs =
      Object.values(baseline.componentBindings).flat().length +
      Object.values(baseline.vendoredPrimitives).flat().length +
      Object.values(baseline.vendoringManifestEntries).flat().length;
    console.log(`[agent-hitl-renders-nothing] wrote baseline: ${pairs} existing pair(s).`);
    return;
  }

  let baseline;
  try {
    baseline = loadBaseline();
  } catch (err) {
    console.error(`[agent-hitl-renders-nothing] configuration error: ${err?.message ?? err}`);
    process.exit(2);
  }

  if (report) {
    console.log(`[agent-hitl-renders-nothing] ${RULE_SENTENCE} (${RULE_ISSUE})`);
    for (const section of ["componentBindings", "vendoredPrimitives", "vendoringManifestEntries"]) {
      const entries = baseline?.[section] ?? {};
      for (const packageName of Object.keys(entries).sort()) {
        for (const detail of listOf(entries, packageName)) {
          console.log(`  allowed (${section}) ${packageName}: ${detail}`);
        }
      }
    }
    return;
  }

  const unknownKinds = unknownKindPackages(packages);
  if (unknownKinds.length) {
    console.error(
      `[agent-hitl-renders-nothing] configuration error: ${unknownKinds.length} extension package(s) declare no known cinatra.kind, so the agent-only rule cannot classify them: ${unknownKinds.join(", ")}`,
    );
    process.exit(2);
  }

  const incomplete = incompleteTreeError(packages, baseline);
  if (incomplete) {
    console.error(`[agent-hitl-renders-nothing] scanner error: ${incomplete}`);
    process.exit(2);
  }

  // Base-ref arm (the regenerate-to-pass bypass): mirrors
  // scripts/audit/file-size-ratchet.mjs. Fail-closed when the ref is set but
  // cannot be resolved; no constraint when the base carries no baseline (the
  // change that introduces it).
  const baseRef = process.env[BASE_ENV_VAR];
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[agent-hitl-renders-nothing] FAIL — ${BASE_ENV_VAR}="${baseRef}" is flag-like.`);
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
        `[agent-hitl-renders-nothing] FAIL — ${BASE_ENV_VAR}="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/extensions/agent-hitl-renders-nothing.baseline.json`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      baseText = null; // ref resolves but the file is absent → the introducing change
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(
          `[agent-hitl-renders-nothing] FAIL — ${RULE_SENTENCE} (${RULE_ISSUE})\n\nThe committed baseline ADDED ${grew.length} pair(s) vs ${baseRef} (regenerate-to-pass bypass); this list may only ever get SHORTER:`,
        );
        for (const p of grew) console.error(`  + ${p.split("|").join(" ")}`);
        process.exit(1);
      }
    }
  }

  const { violations, stale } = evaluate(packages, baseline);

  if (violations.length === 0 && stale.length === 0) {
    const agents = packages.filter((p) => p.kind === "agent").length;
    console.log(
      `[agent-hitl-renders-nothing] OK — no kind:"agent" package draws its own HITL view beyond the baseline (${agents} agent package(s) scanned).`,
    );
    process.exit(0);
  }

  console.error(`[agent-hitl-renders-nothing] FAIL — ${RULE_SENTENCE} (${RULE_ISSUE})`);
  if (violations.length) {
    console.error(
      `\n${violations.length} agent-side rendering declaration${violations.length === 1 ? "" : "s"} NOT in the baseline:`,
    );
    for (const v of violations) console.error(formatFinding(v));
    console.error(
      `\nAn agent package does not draw its own pause screen: the product draws it. Move the component (and the primitives it imports) to the artifact or host surface that owns the view. The baseline is closed to additions — see ${RULE_ISSUE}.`,
    );
  }
  if (stale.length) {
    console.error(
      `\n${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer exist (the ratchet is shrink-only):`,
    );
    for (const s of stale) console.error(formatFinding(s));
    console.error(
      `\nA migration landed — record the win: \`node scripts/extensions/agent-hitl-renders-nothing-gate.mjs --write-baseline\`.`,
    );
  }
  process.exit(1);
}

// Only run the gate when executed directly — importing for unit tests must not
// trigger the scan or process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
