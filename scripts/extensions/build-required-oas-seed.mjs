#!/usr/bin/env node
// Build the required-extension OAS seed for the runtime image (cinatra-ai/ops#436).
//
// WHY THIS EXISTS
// ---------------
// The runtime image carries NO `extensions/` tree: `.dockerignore` excludes it
// and Next's standalone output only traces SERVER-imported files — agent
// `cinatra/oas.json` trees are not imported by `server.js`, so they never reach
// the runtime stage. WayFlow (a separate container) AND the cinatra host process
// both read agent definitions by scanning `resolveAgentInstallDir()` for
// `<vendor>/<slug>/cinatra/oas.json`. When a deploy mounts a PERSISTENT volume
// over that dir (cinatra-ai/ops#431, the regression), the required-set OAS trees
// are seeded ONCE and never refreshed by a new image tag.
//
// This script runs in the BUILD stage AFTER `cinatra extensions acquire-prod`
// has materialized the SHA-pinned required set into `<repoRoot>/extensions/`. It
// projects a SYMLINK-FREE, image-owned SEED of exactly the on-disk files WayFlow
// + the host scanners need — `cinatra/**`, the sibling `package.json`, and
// `skills/**` (host code resolves agent skills from the install dir) — into a
// dedicated seed directory baked into the runtime image. A prod boot phase
// (`required-extension-materialize`) then reconciles this seed into the live
// agent-install dir on every boot, so a new tag refreshes the required set.
//
// SYMLINK-FREE: the acquired `extensions/` tree sits inside a pnpm workspace, so
// blindly copying it would drag in `node_modules` symlinks (dangling in the
// runtime image). This script copies ONLY plain files/dirs from the curated
// subtrees and HARD-FAILS on any symlink it encounters there (fail-closed).
//
// OWNERSHIP MARKER: each seeded slug dir carries a `.cinatra-required-seed.json`
// marker. The boot materializer prunes ONLY dirs that carry this marker and are
// absent from the current seed — so a coexisting user/operator dir (no marker)
// is NEVER pruned. A top-level `manifest.json` records the seeded slug set.
//
// Usage:
//   node scripts/extensions/build-required-oas-seed.mjs \
//     --source <repoRoot>/extensions --out <repoRoot>/.cinatra-required-oas-seed

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const SEED_MARKER_FILENAME = ".cinatra-required-seed.json";
export const SEED_MANIFEST_FILENAME = "manifest.json";
// Per-slug subtrees projected into the seed. WayFlow needs `cinatra/` (the
// oas.json it scans); host code resolves agent skills from `skills/`; the
// sibling `package.json` supplies the version both for the marker backfill and
// for the host package resolution. Nothing else (no src/, no node_modules).
const PROJECTED_SUBTREES = ["cinatra", "skills"];
const PROJECTED_FILES = ["package.json"];

function parseArgs(argv) {
  const args = { source: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i];
    else if (a === "--out") args.out = argv[++i];
  }
  return args;
}

// Copy a subtree (dir) or file with a fail-closed symlink guard. The acquired
// extensions tree must contain only plain files under the projected subtrees;
// any symlink there is a build-time error (it would otherwise dangle at
// runtime).
function copyPlain(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    errorOnExist: false,
    filter: (s) => {
      const st = lstatSync(s);
      if (st.isSymbolicLink()) {
        throw new Error(
          `[build-required-oas-seed] refusing to seed a symlink: ${s} ` +
            `(the projected required-extension subtrees must be plain files)`,
        );
      }
      return true;
    },
  });
}

/**
 * Project the acquired required-extension trees into a symlink-free OAS seed.
 *
 * @returns {{ slugs: Array<{ vendor: string, slug: string }> }}
 */
export function buildRequiredOasSeed({ source, out }) {
  if (!source) throw new Error("[build-required-oas-seed] --source is required");
  if (!out) throw new Error("[build-required-oas-seed] --out is required");

  const sourceRoot = path.resolve(source);
  const outRoot = path.resolve(out);

  // Always rebuild the seed from scratch so a removed required agent does not
  // leave a stale dir baked into the image.
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  const seededSlugs = [];

  if (!existsSync(sourceRoot)) {
    // No acquired extensions at all (e.g. a build with an empty required set).
    // Emit an empty manifest so the boot materializer can distinguish
    // "intentionally empty seed" from "seed missing" (fail-closed) at runtime.
    writeManifest(outRoot, seededSlugs);
    return { slugs: seededSlugs };
  }

  for (const vendorEntry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!vendorEntry.isDirectory() || vendorEntry.name.startsWith(".")) continue;
    const vendor = vendorEntry.name;
    const vendorDir = path.join(sourceRoot, vendor);

    for (const slugEntry of readdirSync(vendorDir, { withFileTypes: true })) {
      if (!slugEntry.isDirectory() || slugEntry.name.startsWith(".")) continue;
      const slug = slugEntry.name;
      const slugDir = path.join(vendorDir, slug);

      // Only seed dirs that actually carry an agent OAS — the unit WayFlow
      // mounts. A non-agent required package (a connector with no oas.json) has
      // nothing for WayFlow to scan and is left out of the seed.
      const cinatraDir = path.join(slugDir, "cinatra");
      const oasPath = path.join(cinatraDir, "oas.json");
      if (!existsSync(oasPath)) continue;
      // Fail closed on a symlinked cinatra/ root or oas.json (path-escape /
      // dangling-at-runtime hazard).
      if (existsSync(cinatraDir) && lstatSync(cinatraDir).isSymbolicLink()) {
        throw new Error(
          `[build-required-oas-seed] refusing to seed a symlinked cinatra/ root: ${cinatraDir}`,
        );
      }
      if (lstatSync(oasPath).isSymbolicLink()) {
        throw new Error(
          `[build-required-oas-seed] refusing to seed a symlinked oas.json: ${oasPath}`,
        );
      }

      const destSlugDir = path.join(outRoot, vendor, slug);
      mkdirSync(destSlugDir, { recursive: true });

      for (const sub of PROJECTED_SUBTREES) {
        const srcSub = path.join(slugDir, sub);
        if (!existsSync(srcSub)) continue;
        // Fail closed on a SYMLINKED projected ROOT — a skipped symlink would
        // silently drop required content (or, if copied, dangle at runtime).
        const st = lstatSync(srcSub);
        if (st.isSymbolicLink()) {
          throw new Error(
            `[build-required-oas-seed] refusing to seed a symlinked projected root: ${srcSub}`,
          );
        }
        if (st.isDirectory()) {
          copyPlain(srcSub, path.join(destSlugDir, sub));
        }
      }
      for (const file of PROJECTED_FILES) {
        const srcFile = path.join(slugDir, file);
        if (!existsSync(srcFile)) continue;
        const st = lstatSync(srcFile);
        if (st.isSymbolicLink()) {
          throw new Error(
            `[build-required-oas-seed] refusing to seed a symlinked projected file: ${srcFile}`,
          );
        }
        if (st.isFile()) {
          copyPlain(srcFile, path.join(destSlugDir, file));
        }
      }

      // Per-slug ownership marker — the boot materializer prunes ONLY dirs
      // carrying this marker.
      writeFileSync(
        path.join(destSlugDir, SEED_MARKER_FILENAME),
        JSON.stringify({ vendor, slug, kind: "required-oas-seed" }, null, 2) + "\n",
        "utf8",
      );
      seededSlugs.push({ vendor, slug });
    }
  }

  writeManifest(outRoot, seededSlugs);
  return { slugs: seededSlugs };
}

function writeManifest(outRoot, seededSlugs) {
  writeFileSync(
    path.join(outRoot, SEED_MANIFEST_FILENAME),
    JSON.stringify(
      {
        kind: "required-oas-seed-manifest",
        generatedAt: new Date().toISOString(),
        slugs: seededSlugs,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/** Read the seed manifest. Returns null when the seed is absent/unreadable. */
export function readSeedManifest(seedRoot) {
  const manifestPath = path.join(seedRoot, SEED_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

// CLI entrypoint (skip when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const { slugs } = buildRequiredOasSeed(args);
  console.log(
    `[build-required-oas-seed] projected ${slugs.length} required agent OAS ` +
      `tree(s) into ${path.resolve(args.out)}` +
      (slugs.length ? `: ${slugs.map((s) => `${s.vendor}/${s.slug}`).join(", ")}` : ""),
  );
}
