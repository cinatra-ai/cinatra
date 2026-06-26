#!/usr/bin/env node
// Generates the build/import configuration that used to be hand-maintained in
// two large, drift-prone blocks:
//
//   1. tsconfig.json  `compilerOptions.paths`         (the @cinatra-ai/* alias map)
//   2. next.config.ts `serverExternalPackages` + `transpilePackages`
//
// from ONE checked-in source of truth: config/build-config.manifest.json.
//
// WHY a manifest (not on-disk auto-derivation): the public repo does NOT carry
// the extensions/ tree (connector packages are mirrored back only in specific CI
// jobs), so the ~100 @cinatra-ai/*-connector aliases cannot be read off
// package.json at generation time. A subset (~131) is derivable from in-tree
// package `exports`, but the relationship is bidirectionally incomplete
// (tsconfig-only aliases like agents/mcp-client; export-only subpaths like
// design/*.css). The manifest is therefore the single, environment-independent,
// byte-exact source — adding/removing a package is ONE manifest edit + regen,
// not scattered tsconfig + next.config hand-edits.
//
// The generator OWNS the formatting of the two regions it writes (it normalizes
// the previously hand-aligned whitespace), exactly like
// generate-extension-manifest.mjs / build-design-registry.mjs own their outputs.
// `--check` is FAIL-CLOSED: it re-renders and byte-compares the on-disk regions,
// exiting 1 on any drift (a hand-edit, a stale regeneration, or a manifest
// change that was not re-rendered).
//
// Usage:
//   node scripts/config/generate-build-config.mjs           # write tsconfig.json + next.config.ts regions
//   node scripts/config/generate-build-config.mjs --check    # byte-exact drift check (no writes; exit 1 on drift)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST_PATH = join(REPO_ROOT, "config", "build-config.manifest.json");
const TSCONFIG_PATH = join(REPO_ROOT, "tsconfig.json");
const NEXT_CONFIG_PATH = join(REPO_ROOT, "next.config.ts");

// ---------------------------------------------------------------------------
// Manifest loading + validation
// ---------------------------------------------------------------------------

/**
 * Validate the manifest shape. Throws a precise error on the first problem so a
 * malformed manifest fails loudly rather than emitting garbage config.
 * Pure (input-only); exported for unit testing.
 */
export function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("manifest must be a JSON object");
  }
  const { tsconfigPaths } = manifest;
  if (!Array.isArray(tsconfigPaths)) {
    throw new Error("manifest.tsconfigPaths must be an array");
  }
  const seen = new Set();
  for (const [i, entry] of tsconfigPaths.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`manifest.tsconfigPaths[${i}] must be an object`);
    }
    if (typeof entry.alias !== "string" || entry.alias.length === 0) {
      throw new Error(`manifest.tsconfigPaths[${i}].alias must be a non-empty string`);
    }
    if (typeof entry.target !== "string" || entry.target.length === 0) {
      throw new Error(`manifest.tsconfigPaths[${i}].target must be a non-empty string (alias ${entry.alias})`);
    }
    if (seen.has(entry.alias)) {
      throw new Error(`manifest.tsconfigPaths has duplicate alias: ${entry.alias}`);
    }
    seen.add(entry.alias);
  }
  for (const key of ["nextServerExternalPackages", "nextTranspilePackages"]) {
    const arr = manifest[key];
    if (!Array.isArray(arr)) {
      throw new Error(`manifest.${key} must be an array`);
    }
    const seenPkgs = new Set();
    for (const [i, item] of arr.entries()) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`manifest.${key}[${i}] must be an object`);
      }
      const hasComment = typeof item.comment === "string";
      const hasPackage = typeof item.package === "string";
      if (hasComment === hasPackage) {
        throw new Error(`manifest.${key}[${i}] must have exactly one of "comment" or "package"`);
      }
      if (hasPackage) {
        if (item.package.length === 0) {
          throw new Error(`manifest.${key}[${i}].package must be a non-empty string`);
        }
        // A duplicate package in serverExternalPackages / transpilePackages is a
        // real (silent) config bug, not just redundancy — reject it at the source.
        if (seenPkgs.has(item.package)) {
          throw new Error(`manifest.${key} has duplicate package: ${item.package}`);
        }
        seenPkgs.add(item.package);
      }
    }
  }
  return manifest;
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config/build-config.manifest.json is not valid JSON: ${err.message}`);
  }
  return validateManifest(manifest);
}

// ---------------------------------------------------------------------------
// Renderers (pure; exported for tests)
// ---------------------------------------------------------------------------

/**
 * Render the `compilerOptions.paths` object body (the lines BETWEEN the opening
 * `{` and the closing `}` of the paths object), at the given indent. The body
 * is JSONC-style `key: [value]` entries, one per line. The LAST entry carries NO
 * trailing comma: tsconfig.json is JSONC (line comments) but at least one
 * consumer (scripts/route-graph.mjs) strips only comments and then strict-
 * JSON.parses it, so a trailing comma after the final entry would break it.
 */
export function renderTsconfigPathsBody(tsconfigPaths, indent = "      ") {
  return tsconfigPaths
    .map(
      ({ alias, target }, i) =>
        `${indent}${JSON.stringify(alias)}: [${JSON.stringify(target)}]` +
        (i < tsconfigPaths.length - 1 ? "," : ""),
    )
    .join("\n");
}

/**
 * Render the body of a next.config array (the lines BETWEEN `[` and `]`), at the
 * given indent. Comment items become `// <text>` lines; package items become
 * `"<name>",` lines.
 */
export function renderNextArrayBody(items, indent = "    ") {
  return items
    .map((item) =>
      typeof item.comment === "string"
        ? `${indent}// ${item.comment}`.replace(/ +$/, "")
        : `${indent}${JSON.stringify(item.package)},`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Region replacement
// ---------------------------------------------------------------------------

/**
 * Replace the body between a `<openMarker>` line and the next line that, when
 * trimmed, equals `<closeTrimmed>`. Returns the new file content. Throws if the
 * region is not found exactly once (defends against the file shape drifting out
 * from under the generator). Pure; exported for tests.
 *
 * @param content    full file text
 * @param openMarker the exact opening line content, trimmed (e.g. `"paths": {`)
 * @param closeTrimmed the trimmed closing line content (e.g. `}` or `],`)
 * @param body       the rendered body (no surrounding newlines)
 */
export function replaceRegion(content, openMarker, closeTrimmed, body) {
  const lines = content.split("\n");
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === openMarker) {
      if (openIdx !== -1) {
        throw new Error(`region open marker is ambiguous (found more than once): ${openMarker}`);
      }
      openIdx = i;
    }
  }
  if (openIdx === -1) {
    throw new Error(`region open marker not found: ${openMarker}`);
  }
  let closeIdx = -1;
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === closeTrimmed) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new Error(`region close marker not found after open (${openMarker}): ${closeTrimmed}`);
  }
  const before = lines.slice(0, openIdx + 1);
  const after = lines.slice(closeIdx);
  return [...before, body, ...after].join("\n");
}

/** Render the full tsconfig.json content with the paths body replaced. */
export function renderTsconfig(currentContent, manifest) {
  return replaceRegion(
    currentContent,
    `"paths": {`,
    `}`,
    renderTsconfigPathsBody(manifest.tsconfigPaths),
  );
}

/** Render the full next.config.ts content with both array bodies replaced. */
export function renderNextConfig(currentContent, manifest) {
  let out = replaceRegion(
    currentContent,
    `serverExternalPackages: [`,
    `],`,
    renderNextArrayBody(manifest.nextServerExternalPackages),
  );
  out = replaceRegion(
    out,
    `transpilePackages: [`,
    `],`,
    renderNextArrayBody(manifest.nextTranspilePackages),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Drift verdict (pure; exported for tests)
// ---------------------------------------------------------------------------

export function checkExitCode(driftPaths) {
  return driftPaths.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const check = process.argv.includes("--check");
  const manifest = loadManifest();

  const targets = [
    { path: TSCONFIG_PATH, rel: "tsconfig.json", render: renderTsconfig },
    { path: NEXT_CONFIG_PATH, rel: "next.config.ts", render: renderNextConfig },
  ];

  if (check) {
    const drift = [];
    for (const t of targets) {
      const current = readFileSync(t.path, "utf8");
      const rendered = t.render(current, manifest);
      if (rendered !== current) drift.push(t.rel);
    }
    if (drift.length > 0) {
      console.error(
        "[build-config] DRIFT — generated config differs from checked-in files:",
      );
      for (const d of drift) console.error(`  - ${d}`);
      console.error(
        "config/build-config.manifest.json is the source of truth. Run\n" +
          "  node scripts/config/generate-build-config.mjs\n" +
          "and commit the result (never hand-edit the paths / package-list regions).",
      );
      process.exit(checkExitCode(drift));
    }
    console.log("[build-config] OK — tsconfig.json + next.config.ts match the manifest.");
    return;
  }

  for (const t of targets) {
    const current = readFileSync(t.path, "utf8");
    const rendered = t.render(current, manifest);
    if (rendered !== current) {
      writeFileSync(t.path, rendered);
      console.log(`[build-config] wrote ${t.rel}`);
    } else {
      console.log(`[build-config] ${t.rel} already up to date`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
