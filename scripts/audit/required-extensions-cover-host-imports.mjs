#!/usr/bin/env node
// CI gate: the required-extension declaration + acquisition lock must COVER
// the host's real extension import surface.
//
// `cinatra.requiredExtensions` (root package.json) declares the prod
// base-image BOOTABLE SET: every extension package the production build
// cannot resolve without. The committed acquisition lock
// (cinatra-required-extensions.lock.json) pins exactly that set for the prod
// image build. The honest definition of the bootable set is derived from the
// CODE, not maintained by hand:
//
//   bootable = (extension packages HARD-imported by non-test host source
//               under src/ AND packages/ — the generated maps in
//               src/lib/generated are EXCLUDED here and classified below)
//            ∪ (extension packages the generated maps reference whose
//               generator-owned `resolution` metadata is "required" — or is
//               missing/unknown/unproven, which counts as required FAIL-CLOSED)
//            ∪ (root package.json dependencies that are extension packages)
//
// Guarded-optional class (cinatra#7, dep-drop slice): a generated-map entry the
// generator classified `resolution: "guardedOptional"` routes through the
// standardized degraded-result guard (src/lib/extension-load-guard.ts) and is
// PROVEN degradable by the generated test
// (src/lib/generated/__tests__/guarded-optional-loaders.test.ts, byte-pinned
// by `generate-extension-manifest.mjs --check`). Such a package is NOT part
// of the bootable set — it is ACQUIRABLE-ON-DEMAND (marketplace-managed).
// This gate trusts ONLY the generator-owned classification as emitted in the
// generated artifacts — never source-shape inference. Fail-closed rules:
//   - a generated import whose entry cannot be parsed/classified ⇒ required;
//   - a guardedOptional entry NOT covered by the generated test ⇒ required;
//   - resolution values other than "guardedOptional" ⇒ required;
//   - a STATIC_EXTENSION_MANIFEST record with resolution "required" ⇒
//     required (the system set), even without a loader entry.
//
// This gate FAILS when:
//   - a bootable extension package is missing from requiredExtensions, or
//   - a bootable extension package is missing from the acquisition lock, or
//   - the lock and requiredExtensions drift apart in either direction
//     (run scripts/extensions/update-required-extension-lock.mjs), or
//   - cinatra.systemExtensions ⊄ cinatra.requiredExtensions (the system set
//     must always ride the bootable declaration), or
//   - cinatra.requiredExtensions ⊄ cinatra.systemExtensions — the DECLARATION
//     EQUALITY guard (cinatra#151 Stage 7, the zero-floor end-state):
//     together with the two subset checks above this pins
//     requiredExtensions == systemExtensions == lock. The prod bootable
//     declaration may not grow beyond the system set; a package that must
//     become required needs an owner ruling that also declares it a
//     systemExtension (one reviewed edit, both lists). This guard pins the
//     DECLARATIONS only — regrowth of hard-coded extension names anywhere in
//     code is caught by the two PINNED-EMPTY coupling gates, and a hard
//     import of an undeclared package is caught by the live bootable-coverage
//     derivation above, not by this equality.
//
// The HARD-import scan is deliberately conservative: it counts type-only
// imports too (a missing package still breaks `pnpm typecheck` and a local
// `docker build`'s in-build tsc), so the covered set can only over-approximate
// the value-import surface, never under-cover it. Declared-but-unimported
// packages are fine — required may be a superset of the bootable surface,
// never a subset.
//
// Comment handling: the scan uses the SHARED single-pass lexer
// (scripts/audit/lib/strip-comments.mjs — the same one the instance-coupling
// gate adopted) instead of the legacy regex pair. The legacy regex went
// blind after a LINE comment containing a literal `/*` (e.g. the `@/lib/*`
// header in src/lib/register-transport-connectors.ts, whose four connector
// imports this gate MUST count) — that under-coverage hole is closed here.
// (The import-ban gate deliberately keeps its legacy stripper: its FROZEN
// baseline may never grow, so its correction lands only WITH the residual
// edges' own cutover — see the gates doc. This gate is live-coverage, not
// baseline-ratcheted, so adopting the shared lexer is pure honesty gain.)
//
// Fail-closed: refuses to run against an absent/under-populated extensions/
// tree (the banned-name set would be empty and the gate would pass vacuously).
//
// Usage:
//   node scripts/audit/required-extensions-cover-host-imports.mjs

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";
import { stripComments } from "./lib/strip-comments.mjs";
import { discoverExtensionNames } from "./core-extension-import-ban.mjs";
import { GENERATED_MANIFEST_FILES } from "../extensions/generated-manifest-files.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const LOCK_PATH = join(REPO_ROOT, "cinatra-required-extensions.lock.json");

const GENERATED_TREE_PREFIX = "src/lib/generated/";
const GENERATED_TEST_FILE = "src/lib/generated/__tests__/guarded-optional-loaders.test.ts";

// Same capture as the import-ban gates: the BASE package of any scoped import
// (any subpath), across `from` / dynamic `import()` / `require()`.
const PKG_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](@[a-z0-9-]+\/[a-z0-9-]+)(?:\/[^"']*)?["']/g;
// Full-specifier variant for the generated-tree fail-closed net: every
// import-position SPECIFIER must be accounted for by a classified loader
// entry — per specifier, not per package, so a classified entry can never
// mask an unclassified sibling import of the same package.
const FULL_SPEC_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](@[a-z0-9-]+\/[a-z0-9-]+(?:\/[^"']*)?)["']/g;

function isTestPath(rel) {
  return (
    /\.(test|spec)\.m?[tj]sx?$/.test(rel) ||
    /(^|\/)__tests__(\/|$)/.test(rel) ||
    /(^|\/)__mocks__(\/|$)/.test(rel) ||
    /(^|\/)tests?(\/|$)/.test(rel)
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

/**
 * Extension packages HARD-imported by non-test host source under the given
 * roots. With `excludeGenerated` (the gate's mode) the generated tree under
 * src/lib/generated is skipped — its references are classified separately via
 * the generator-owned `resolution` metadata (see classifyGeneratedReferences).
 * Returns `{ names: Set, byFile: { [relFile]: [names] } }`.
 */
export function scanHostImportedExtensions(
  roots,
  extensionNames,
  repoRoot = REPO_ROOT,
  { excludeGenerated = false } = {},
) {
  const names = new Set();
  const byFile = {};
  for (const root of roots) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, [])) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (isTestPath(rel)) continue;
      if (excludeGenerated && rel.startsWith(GENERATED_TREE_PREFIX)) continue;
      const code = stripComments(readFileSync(file, "utf8"));
      const hits = new Set();
      let m;
      PKG_IMPORT_RE.lastIndex = 0;
      while ((m = PKG_IMPORT_RE.exec(code)) !== null) {
        if (extensionNames.has(m[1])) hits.add(m[1]);
      }
      if (hits.size) {
        byFile[rel] = [...hits].sort();
        for (const h of hits) names.add(h);
      }
    }
  }
  return { names, byFile };
}

// ---------------------------------------------------------------------------
// Generated-tree classification (generator-owned `resolution` metadata)
// ---------------------------------------------------------------------------

const LOADER_BLOCK_RE = /export const ([A-Z0-9_]+)\s*:\s*Record<[^=]+=\s*\{([\s\S]*?)\n\};/g;
const LOADER_ENTRY_RE =
  /"([^"]+)":\s*\{\s*resolution:\s*"([^"]+)"\s*,\s*load:\s*(?:guardedExtensionImport\(\s*"([^"]+)"|\(\)\s*=>\s*import\(\s*"([^"]+)")/g;
const RECORD_LINE_RE = /^\s*"(@[^"]+)":\s*(\{"packageName":.*\}),?\s*$/;
const EXPECTED_ENTRY_RE = /\{\s*map:\s*"([^"]+)",\s*key:\s*"([^"]+)",\s*resolution:\s*"([^"]+)"\s*\}/g;

/**
 * Classify every extension package the generated maps reference, trusting
 * ONLY the emitted generator-owned `resolution` metadata (byte-pinned by
 * `generate-extension-manifest.mjs --check`). Pure (string inputs) — unit
 * tested. Returns:
 *   { bootable: Set, acquirable: Set, reasons: { [pkg]: [why...] } }
 * FAIL-CLOSED: any referenced package that is not positively classified
 * guardedOptional-and-proven lands in `bootable`.
 *
 * @param {Object} input
 * @param {Array<{rel: string, source: string}>} input.generatedSources
 *        Non-test generated files (extensions.server.ts etc.).
 * @param {string|null} input.generatedTestSource
 *        Source of the generated guarded-optional-loaders test (the proof
 *        artifact), or null when missing (⇒ nothing is acquirable).
 * @param {Set<string>} input.extensionNames
 */
export function classifyGeneratedReferences({ generatedSources, generatedTestSource, extensionNames }) {
  const bootable = new Set();
  const acquirable = new Set();
  const reasons = {};
  const addReason = (pkg, why) => {
    (reasons[pkg] ??= []).push(why);
  };
  const forceBootable = (pkg, why) => {
    bootable.add(pkg);
    acquirable.delete(pkg);
    addReason(pkg, why);
  };

  // The proof artifact: (map, key) pairs the generated test pins as
  // guardedOptional-and-degradable. Missing/empty test ⇒ empty set ⇒ every
  // guardedOptional entry counts as required (fail-closed).
  const proven = new Set();
  if (typeof generatedTestSource === "string") {
    let em;
    EXPECTED_ENTRY_RE.lastIndex = 0;
    while ((em = EXPECTED_ENTRY_RE.exec(generatedTestSource)) !== null) {
      if (em[3] === "guardedOptional") proven.add(`${em[1]}::${em[2]}`);
    }
  }

  const basePkg = (spec) => spec.split("/").slice(0, 2).join("/");
  // Tracks every import-position SPECIFIER a classified loader entry
  // accounted for, so the fail-closed net below can force any UNACCOUNTED
  // specifier bootable — per specifier, never per package (a classified entry
  // must not mask an unclassified sibling import of the same package).
  const classifiedSpecs = new Set();
  // Every import-position specifier seen anywhere in the generated tree.
  const rawSpecs = new Set();

  for (const { source } of generatedSources) {
    // 1) STATIC_EXTENSION_MANIFEST records — single-line JSON values, the
    //    generator-owned record classification. `required` records (the
    //    system set) are bootable even without loader entries; guardedOptional
    //    records are PASSIVE metadata (never bootable by themselves).
    for (const line of source.split("\n")) {
      const rm = RECORD_LINE_RE.exec(line);
      if (!rm) continue;
      const pkg = rm[1];
      if (!extensionNames.has(pkg)) continue;
      let record;
      try {
        record = JSON.parse(rm[2]);
      } catch {
        forceBootable(pkg, "manifest record JSON unparseable (fail-closed)");
        continue;
      }
      if (record.resolution === "required") {
        forceBootable(pkg, "manifest record resolution=required (system set)");
      } else if (record.resolution !== "guardedOptional") {
        forceBootable(pkg, `manifest record resolution missing/unknown: ${JSON.stringify(record.resolution)} (fail-closed)`);
      }
    }

    // 2) Loader-map entries — per-entry resolution + literal specifier.
    let bm;
    LOADER_BLOCK_RE.lastIndex = 0;
    while ((bm = LOADER_BLOCK_RE.exec(source)) !== null) {
      const mapName = bm[1];
      const body = bm[2];
      let em;
      LOADER_ENTRY_RE.lastIndex = 0;
      while ((em = LOADER_ENTRY_RE.exec(body)) !== null) {
        const [, key, resolution, guardedSpec, plainSpec] = em;
        const spec = guardedSpec ?? plainSpec;
        const pkg = basePkg(spec);
        if (!extensionNames.has(pkg)) continue;
        classifiedSpecs.add(spec);
        if (resolution === "guardedOptional") {
          if (guardedSpec === undefined) {
            forceBootable(pkg, `${mapName}["${key}"] guardedOptional but NOT routed through guardedExtensionImport (fail-closed)`);
          } else if (!proven.has(`${mapName}::${key}`)) {
            forceBootable(pkg, `${mapName}["${key}"] guardedOptional but NOT covered by the generated degradation test (fail-closed)`);
          } else if (!bootable.has(pkg)) {
            acquirable.add(pkg);
            addReason(pkg, `${mapName}["${key}"] guardedOptional + proven degradable`);
          }
        } else if (resolution === "required") {
          forceBootable(pkg, `${mapName}["${key}"] resolution=required`);
        } else {
          forceBootable(pkg, `${mapName}["${key}"] resolution unknown: ${JSON.stringify(resolution)} (fail-closed)`);
        }
      }
    }

    // 3) Fail-closed net: ANY import-position SPECIFIER in the generated
    //    tree that no classified entry accounted for ⇒ its package is
    //    required. Runs per source AFTER that source's entry pass, but the
    //    classifiedSpecs set spans all sources; collect first, check after
    //    the loop so cross-file entries still count.
    let im;
    FULL_SPEC_IMPORT_RE.lastIndex = 0;
    while ((im = FULL_SPEC_IMPORT_RE.exec(source)) !== null) {
      const spec = im[1];
      const pkg = basePkg(spec);
      if (!extensionNames.has(pkg)) continue;
      rawSpecs.add(spec);
    }
  }

  for (const spec of rawSpecs) {
    if (!classifiedSpecs.has(spec)) {
      forceBootable(
        basePkg(spec),
        `generated-tree import "${spec}" without a classified loader entry (fail-closed)`,
      );
    }
  }

  return { bootable, acquirable, reasons };
}

/** Read the generated artifacts off disk for classifyGeneratedReferences. */
export function readGeneratedArtifacts(repoRoot = REPO_ROOT) {
  const generatedSources = [];
  let generatedTestSource = null;
  for (const rel of GENERATED_MANIFEST_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const source = readFileSync(abs, "utf8");
    if (rel === GENERATED_TEST_FILE) generatedTestSource = source;
    else generatedSources.push({ rel, source });
  }
  return { generatedSources, generatedTestSource };
}

/** Names (ranges stripped) declared in cinatra.requiredExtensions — mirrors
 * the canonical parser's last-`@` split. */
export function readDeclaredRequiredNames(pkgJson) {
  const raw = Array.isArray(pkgJson?.cinatra?.requiredExtensions) ? pkgJson.cinatra.requiredExtensions : [];
  const names = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) continue;
    const trimmed = entry.trim();
    const at = trimmed.lastIndexOf("@");
    names.push(at <= 0 ? trimmed : trimmed.slice(0, at));
  }
  return new Set(names);
}

/** Pure coverage verdict — exported for unit tests. */
export function coverageDefects({ hostImported, rootDepExtensions, required, locked, systemExtensions = new Set() }) {
  const bootable = new Set([...hostImported, ...rootDepExtensions]);
  const defects = [];
  for (const name of [...bootable].sort()) {
    if (!required.has(name)) {
      defects.push(`host-imported extension ${name} is MISSING from cinatra.requiredExtensions`);
    }
    if (!locked.has(name)) {
      defects.push(`host-imported extension ${name} is MISSING from the acquisition lock`);
    }
  }
  for (const name of [...required].sort()) {
    if (!locked.has(name)) {
      defects.push(`required extension ${name} has no acquisition-lock entry (regenerate the lock)`);
    }
  }
  for (const name of [...locked].sort()) {
    if (!required.has(name)) {
      defects.push(`acquisition-lock entry ${name} is not declared in cinatra.requiredExtensions (stale lock)`);
    }
  }
  for (const name of [...systemExtensions].sort()) {
    if (!required.has(name)) {
      defects.push(`system extension ${name} is MISSING from cinatra.requiredExtensions (systemExtensions ⊆ requiredExtensions must hold)`);
    }
  }
  // DECLARATION EQUALITY (cinatra#151 Stage 7): requiredExtensions may not
  // exceed systemExtensions — with the subset check above and the lock<->
  // required drift checks this enforces requiredExtensions == systemExtensions
  // == lock. Fail-closed by construction: an empty/absent systemExtensions
  // declaration flags every required name.
  for (const name of [...required].sort()) {
    if (!systemExtensions.has(name)) {
      defects.push(
        `required extension ${name} is NOT declared in cinatra.systemExtensions (requiredExtensions == systemExtensions equality guard — the bootable declaration may not grow beyond the system set without an owner ruling that also declares the package a systemExtension)`,
      );
    }
  }
  return { bootable, defects };
}

/**
 * The full live computation against a repo tree — shared by main() and the
 * repo-live test so the two can never drift.
 */
export function computeLiveCoverage(repoRoot = REPO_ROOT) {
  const extensionNames = discoverExtensionNames();
  const pkgJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

  const { names: hardImported, byFile } = scanHostImportedExtensions(
    ["src", "packages"],
    extensionNames,
    repoRoot,
    { excludeGenerated: true },
  );
  const generated = classifyGeneratedReferences({
    ...readGeneratedArtifacts(repoRoot),
    extensionNames,
  });
  const hostImported = new Set([...hardImported, ...generated.bootable]);
  const rootDepExtensions = new Set(
    Object.keys(pkgJson.dependencies ?? {}).filter((d) => extensionNames.has(d)),
  );
  const required = readDeclaredRequiredNames(pkgJson);
  const systemExtensions = new Set(
    Array.isArray(pkgJson?.cinatra?.systemExtensions) ? pkgJson.cinatra.systemExtensions : [],
  );
  return {
    extensionNames,
    pkgJson,
    byFile,
    hardImported,
    generated,
    hostImported,
    rootDepExtensions,
    required,
    systemExtensions,
  };
}

function main() {
  // Fail-closed: an absent/under-populated extensions/ tree would make the
  // extension-name set empty and this gate would pass vacuously.
  assertExtensionsPresent(REPO_ROOT, "required-extensions-cover-host-imports");

  const {
    byFile,
    hardImported,
    generated,
    hostImported,
    rootDepExtensions,
    required,
    systemExtensions,
  } = computeLiveCoverage(REPO_ROOT);

  let locked = new Set();
  if (!existsSync(LOCK_PATH)) {
    console.error(
      "[required-extensions-cover-host-imports] FAIL — cinatra-required-extensions.lock.json is missing. " +
        "Regenerate it with `node scripts/extensions/update-required-extension-lock.mjs` and commit it.",
    );
    process.exit(1);
  }
  try {
    locked = new Set(
      (JSON.parse(readFileSync(LOCK_PATH, "utf8")).packages ?? []).map((p) => p.packageName),
    );
  } catch (err) {
    console.error(`[required-extensions-cover-host-imports] FAIL — unreadable lock: ${err.message}`);
    process.exit(1);
  }

  const { bootable, defects } = coverageDefects({
    hostImported,
    rootDepExtensions,
    required,
    locked,
    systemExtensions,
  });

  if (defects.length > 0) {
    console.error(
      `[required-extensions-cover-host-imports] FAIL — ${defects.length} coverage defect(s):`,
    );
    for (const d of defects) console.error("  - " + d);
    // Remediation branches by defect class (the equality guard's fix is the
    // OPPOSITE direction of the coverage fix — never "add to required"), and
    // each section prints ONLY when its class is present.
    const equalityDefects = defects.filter((d) => d.includes("equality guard"));
    const coverageDefectsPresent = defects.length > equalityDefects.length;
    if (equalityDefects.length) {
      console.error(
        "\nEquality-guard remediation: requiredExtensions == systemExtensions is the zero-floor end-state " +
          "(cinatra#151 Stage 7). Either REMOVE the package from cinatra.requiredExtensions (and regenerate the " +
          "lock via `node scripts/extensions/update-required-extension-lock.mjs`), or — with an owner ruling — " +
          "declare it in cinatra.systemExtensions too (then regenerate the generated maps AND the lock).",
      );
    }
    if (coverageDefectsPresent) {
      console.error(
        "\nCoverage remediation: add the package to cinatra.requiredExtensions (with its version range), run " +
          "`node scripts/extensions/update-required-extension-lock.mjs`, and commit both. Hard import sites:",
      );
      for (const [file, names] of Object.entries(byFile)) {
        const offending = names.filter((n) => !required.has(n) || !locked.has(n));
        if (offending.length) console.error(`    ${file} -> ${offending.join(", ")}`);
      }
      for (const [pkg, why] of Object.entries(generated.reasons)) {
        if (!required.has(pkg) || !locked.has(pkg)) {
          console.error(`    [generated] ${pkg}: ${why.join("; ")}`);
        }
      }
    }
    process.exit(1);
  }

  console.log(
    `[required-extensions-cover-host-imports] OK — bootable set covered: ${bootable.size} package(s) ` +
      `(${hardImported.size} hard-imported, ${generated.bootable.size} generated-required, ` +
      `${rootDepExtensions.size} root-dep) ⊆ requiredExtensions (${required.size}) == systemExtensions (${systemExtensions.size}) == lock (${locked.size}) ` +
      `(declaration equality pinned — cinatra#151 Stage 7); ` +
      `${generated.acquirable.size} generated-map package(s) classified guardedOptional ⇒ acquirable-on-demand.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
