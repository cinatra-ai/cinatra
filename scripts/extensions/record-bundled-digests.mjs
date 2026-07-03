#!/usr/bin/env node
// Bundled-payload content-digest recorder (cinatra#795).
//
// The unified runtime store (#791/#792) gives every INSTALLED extension a
// content-addressed `<kind>/<slug>/<digest>` identity. Bundled/image packages
// deliberately stay on the SEALED static-manifest import (no store read,
// no-network boot) — this script records the missing half of their identity
// parity: a deterministic content digest per bundled extension payload,
// computed at IMAGE BUILD time (the only point where the payload is sealed
// and stable) and consumed at boot by the static-bundle lifecycle seeder
// (src/lib/static-bundle-lifecycle.ts), which stamps it into the platform
// anchor row's typed `source.digest` (`ExtensionSourceBundled`).
//
// The digest is deliberately NOT part of the committed generated maps: those
// are byte-exact drift-checked (`generate-extension-manifest.mjs --check`),
// and a full-content hash there would fail CI on every extension source edit.
// The image build (Dockerfile) is the recording authority; a dev boot simply
// has no recorded digests (the anchor `digest` field is optional by design).
//
// Digest algorithm — a LITERAL MIRROR of `contentHashOfEntries` in
// src/lib/extension-package-store-core.ts (this plain .mjs build script cannot
// import the TS host module): entries sorted by POSIX relPath, folding
// `relPath\0<sha512hex(bytes)>\n` into a single hex sha512. The mirror is
// parity-tested (scripts/extensions/__tests__/record-bundled-digests.test.ts)
// against the canonical TS implementation, so drift fails CI. The output is a
// 128-hex string — the same `<digest>` path-segment grammar the store uses
// (`isStoreDigestSegment`), though bundled digests never become store paths.
//
// Determinism exclusions (name-keyed, any depth):
//   - node_modules/ + .git/ — populated between acquisition and build (pnpm
//     links, workspace symlinks), never part of the payload;
//   - .cinatra-acquired.json — the acquisition marker `cinatra setup prod`
//     writes AFTER verification (the acquisition tree hash excludes it too;
//     see packages/cli/src/prod-extension-acquisition.mjs), so identical
//     payloads must not digest differently across fresh builds;
//   - .cinatra-store.json — the runtime store sidecar name, defensively;
//   - symlinks (file or dir) — identity depends only on regular-file bytes.
//
// Usage:
//   node scripts/extensions/record-bundled-digests.mjs \
//     --source <extensionsRoot> --out <file.json>
//
// Fail-closed: an unreadable package manifest or an EMPTY extension tree exits
// non-zero — the Dockerfile step must never silently record nothing.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/** Directory names never part of a bundled payload (skipped at any depth). */
export const BUNDLED_DIGEST_EXCLUDED_DIRNAMES = new Set(["node_modules", ".git"]);

/** File names never part of a bundled payload (skipped at any depth). */
export const BUNDLED_DIGEST_EXCLUDED_FILENAMES = new Set([
  ".cinatra-acquired.json", // acquisition marker (ACQUISITION_MARKER_FILENAME)
  ".cinatra-store.json", // runtime-store sidecar (STORE_SIDECAR_FILENAME)
]);

/**
 * LITERAL MIRROR of `contentHashOfEntries` (src/lib/extension-package-store-core.ts).
 * Parity-tested — do not change one without the other.
 * @param {ReadonlyArray<{ relPath: string, bytes: Uint8Array }>} entries
 * @returns {string} hex sha512
 */
export function contentHashOfEntriesMirror(entries) {
  const sorted = [...entries].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const outer = createHash("sha512");
  for (const e of sorted) {
    const inner = createHash("sha512").update(e.bytes).digest("hex");
    outer.update(e.relPath);
    outer.update("\0");
    outer.update(inner);
    outer.update("\n");
  }
  return outer.digest("hex");
}

/**
 * Collect the digest-relevant payload entries of a package dir: regular files
 * only, POSIX relPaths, exclusions above applied at any depth.
 * @param {string} dir
 * @returns {Array<{ relPath: string, bytes: Uint8Array }>}
 */
export function collectPayloadEntries(dir) {
  /** @type {Array<{ relPath: string, bytes: Uint8Array }>} */
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue; // regular files only — deterministic identity
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (BUNDLED_DIGEST_EXCLUDED_DIRNAMES.has(entry.name)) continue;
        walk(join(abs, entry.name), childRel);
      } else if (entry.isFile()) {
        if (BUNDLED_DIGEST_EXCLUDED_FILENAMES.has(entry.name)) continue;
        out.push({ relPath: childRel, bytes: readFileSync(join(abs, entry.name)) });
      }
      // FIFOs/sockets/devices: never payload — ignored.
    }
  };
  walk(dir, "");
  return out;
}

/**
 * The content digest of one bundled package payload dir.
 * @param {string} dir
 * @returns {string} hex sha512 (128 chars — store `<digest>` segment grammar)
 */
export function computeBundledPackageDigest(dir) {
  return contentHashOfEntriesMirror(collectPayloadEntries(dir));
}

/**
 * Record digests for every package under `extRoot` (`<extRoot>/<scope>/<slug>/`
 * dirs holding a package.json — the same universe the inventory/generator scan).
 * @param {string} extRoot
 * @returns {{ formatVersion: 1, generatedBy: string, algorithm: string, packages: Record<string, { version: string, kind: string | null, digest: string }> }}
 */
export function recordBundledDigests(extRoot) {
  /** @type {Record<string, { version: string, kind: string | null, digest: string }>} */
  const packages = {};
  if (!existsSync(extRoot)) {
    throw new Error(`extension root does not exist: ${extRoot}`);
  }
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(extRoot, scope.name);
    for (const ext of readdirSync(scopeDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const dir = join(scopeDir, ext.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")); // fail-closed on parse error
      if (typeof pkg.name !== "string" || pkg.name.length === 0) {
        throw new Error(`package.json without a name: ${pkgPath}`);
      }
      packages[pkg.name] = {
        // `?? "0.0.0"` mirrors the seeder's `rec.version ?? "0.0.0"` fallback so
        // the boot-time version cross-check compares like with like.
        version: typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0",
        kind: typeof pkg.cinatra?.kind === "string" ? pkg.cinatra.kind : null,
        digest: computeBundledPackageDigest(dir),
      };
    }
  }
  // Deterministic emission order.
  const sorted = Object.fromEntries(
    Object.entries(packages).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    formatVersion: 1,
    generatedBy: "scripts/extensions/record-bundled-digests.mjs",
    algorithm: "cinatra-content-hash-v1 (contentHashOfEntries fold, hex sha512)",
    packages: sorted,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

async function main() {
  const args = process.argv.slice(2);
  const source = argValue(args, "--source") ?? join(REPO_ROOT, "extensions");
  const out = argValue(args, "--out");
  if (!out) {
    console.error("usage: record-bundled-digests.mjs --source <extensionsRoot> --out <file.json>");
    process.exit(2);
  }
  const doc = recordBundledDigests(source);
  const count = Object.keys(doc.packages).length;
  if (count === 0) {
    console.error(`[record-bundled-digests] FAIL: no packages found under ${source}`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`[record-bundled-digests] recorded ${count} bundled package digest(s) → ${out}`);
}

// Only run the CLI when invoked directly — importing the helpers (parity
// tests) must NOT execute main(). Same pattern as inventory.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
