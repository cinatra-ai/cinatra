#!/usr/bin/env node
// CI gate: the required-extension declaration + acquisition lock must COVER
// the host's real extension import surface.
//
// `cinatra.requiredExtensions` (root package.json) declares the prod
// base-image BOOTABLE SET: every extension package the production build
// cannot resolve without. The committed acquisition lock
// (cinatra-required-extensions.lock.json) pins exactly that set for the prod
// image build. The host, however, still imports extension packages directly
// (the tolerated IoC debt ratcheted by core-extension-import-ban /
// core-extension-instance-coupling-ban) — so the honest definition of the
// bootable set is derived from the CODE, not maintained by hand:
//
//   bootable = (extension packages imported by non-test host source under
//               src/ AND packages/, INCLUDING the generated maps in
//               src/lib/generated which the import-ban gate exempts)
//            ∪ (root package.json dependencies that are extension packages)
//
// This gate FAILS when:
//   - a host-imported extension package is missing from requiredExtensions, or
//   - a host-imported extension package is missing from the acquisition lock
//     (the prod image would build a tree that cannot resolve the import), or
//   - the lock and requiredExtensions drift apart in either direction
//     (the lock is generated FROM the declaration; drift means a forgotten
//     regeneration — run scripts/extensions/update-required-extension-lock.mjs).
//
// The import scan is deliberately conservative: it counts type-only imports
// too (a missing package still breaks `pnpm typecheck` and a local
// `docker build`'s in-build tsc), so the covered set can only over-approximate
// the value-import surface, never under-cover it. Declared-but-unimported
// packages (the genuine system agents/skills) are fine — required may be a
// superset of the import surface, never a subset.
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
import { discoverExtensionNames } from "./core-extension-import-ban.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const LOCK_PATH = join(REPO_ROOT, "cinatra-required-extensions.lock.json");

// Same capture as the import-ban gates: the BASE package of any scoped import
// (any subpath), across `from` / dynamic `import()` / `require()`.
const PKG_IMPORT_RE = /(?:from|import|require)\s*\(?\s*["'](@[a-z0-9-]+\/[a-z0-9-]+)(?:\/[^"']*)?["']/g;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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
 * Extension packages imported by non-test host source under the given roots
 * (generated files INCLUDED — they are part of the production build graph).
 * Returns `{ names: Set, byFile: { [relFile]: [names] } }`.
 */
export function scanHostImportedExtensions(roots, extensionNames, repoRoot = REPO_ROOT) {
  const names = new Set();
  const byFile = {};
  for (const root of roots) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs, [])) {
      const rel = relative(repoRoot, file).split("\\").join("/");
      if (isTestPath(rel)) continue;
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
export function coverageDefects({ hostImported, rootDepExtensions, required, locked }) {
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
  return { bootable, defects };
}

function main() {
  // Fail-closed: an absent/under-populated extensions/ tree would make the
  // extension-name set empty and this gate would pass vacuously.
  assertExtensionsPresent(REPO_ROOT, "required-extensions-cover-host-imports");

  const extensionNames = discoverExtensionNames();
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const { names: hostImported, byFile } = scanHostImportedExtensions(["src", "packages"], extensionNames);
  const rootDepExtensions = new Set(
    Object.keys(pkgJson.dependencies ?? {}).filter((d) => extensionNames.has(d)),
  );
  const required = readDeclaredRequiredNames(pkgJson);

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

  const { bootable, defects } = coverageDefects({ hostImported, rootDepExtensions, required, locked });

  if (defects.length > 0) {
    console.error(
      `[required-extensions-cover-host-imports] FAIL — ${defects.length} coverage defect(s):`,
    );
    for (const d of defects) console.error("  - " + d);
    console.error(
      "\nRemediation: add the package to cinatra.requiredExtensions (with its version range), run " +
        "`node scripts/extensions/update-required-extension-lock.mjs`, and commit both. Import sites:",
    );
    for (const [file, names] of Object.entries(byFile)) {
      const offending = names.filter((n) => !required.has(n) || !locked.has(n));
      if (offending.length) console.error(`    ${file} -> ${offending.join(", ")}`);
    }
    process.exit(1);
  }

  console.log(
    `[required-extensions-cover-host-imports] OK — bootable set covered: ${bootable.size} host-referenced ` +
      `extension package(s) ⊆ requiredExtensions (${required.size}) = lock (${locked.size}).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
