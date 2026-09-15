#!/usr/bin/env node
// Dev-fleet extension acquisition for the image build stage.
//
// WHAT THIS IS
// ------------
// The image's build stage acquires the PROD BOOTABLE SET — the packages of
// `cinatra-required-extensions.lock.json` — through the published CLI's
// `extensions acquire-prod`. That set is what a real deployment carries, and it
// is the only set today's image has ever carried.
//
// A PREVIEW / PROOF instance needs more: the packs a DEVELOPMENT boot syncs
// (`cinatra-dev-extensions.lock.json` — the agent fleet a person actually runs a
// proof with). This script materializes that fleet into the SAME
// `extensions/<scope>/<name>` slots the required set lands in, so every step
// that follows in the build stage — the OAS seed projection, the presence-aware
// manifest regeneration, the bundled-digest record — reads the materialized set
// exactly as it is, with no knowledge of which fleet produced it.
//
// It is selected by the `CINATRA_EXTENSION_FLEET` build argument:
//
//   required  (the DEFAULT, and the ONLY road a real deployment takes)
//             this script is a NO-OP: it touches no file and makes no request.
//   dev       the fleet is acquired on top of the already-acquired required set.
//
// THE dev ROAD IS NEVER A REAL DEPLOYMENT'S ROAD. It exists so a preview
// instance has agents to run a proof with, and nothing else.
//
// WHY THE TARBALL ROAD AND NOT THE DEV CHECKOUT SCRIPT
// ----------------------------------------------------
// `scripts/ci/sync-dev-extensions.mjs --pinned` is how CI and a dev checkout
// materialize this fleet, and it is pinned to the same lock — but it cannot run
// in the build stage:
//   * it syncs EVERY `cinatra.devExtensions` entry (the whole 116-package
//     universe), the required set included, so it would re-clone over the
//     verified trees `acquire-prod` just put down; and
//   * its clone helper HARD-FAILS on a non-empty, non-git directory — which is
//     precisely what each of those required slots is at that point in the build.
// So the fleet is acquired over the SAME hardened codeload-tarball road the
// required acquisition uses (the primitives are imported from it, not
// re-implemented): an immutable commit SHA in the URL, the whole archive
// inspected in memory before anything touches disk (entry-type allowlist, path
// hardening, bounded compressed/decompressed/per-file sizes and entry count),
// the root `package.json` name verified against the lock, extraction to a temp
// sibling, a re-hash of what actually landed, then an atomic swap into place.
// That also keeps `git` out of the build stage entirely — on BOTH roads.
//
// WHAT THE dev ROAD DOES *NOT* DO
// -------------------------------
// It never weakens the required road's guarantees. The required set is acquired
// first, from its own lock, with its own tree-hash verification, and this script
// REFUSES any package that lock owns (a package pinned in both locks is a
// two-authority defect and fails the build loudly). It also refuses to overwrite
// any directory it does not own.
//
// The dev lock's schema carries `packageName` + `repo` + `resolvedSha` and NOT
// the required lock's `treeSha256`/`packageVersion`, so the integrity a dev-road
// pack gets is: the immutable SHA in the URL, the full archive hardening, and
// the name check — stated here plainly rather than implied. The tree hash of
// what landed is COMPUTED and recorded in the acquisition marker, so a re-run
// re-verifies the tree it wrote rather than trusting it.
//
// Usage:
//   node scripts/extensions/acquire-dev-fleet.mjs --fleet dev
//   node scripts/extensions/acquire-dev-fleet.mjs --fleet required   (no-op)

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  ACQUISITION_MARKER_FILENAME,
  computeTreeSha256FromDir,
  downloadBounded,
  extractVerifiedTarball,
  foldTreeHash,
  gunzipBounded,
  inspectTarball,
} from "../../packages/cli/src/prod-extension-acquisition.mjs";
import {
  DEV_EXTENSIONS_LOCK_FILENAME,
  REQUIRED_EXTENSIONS_LOCK_FILENAME,
  destDirForExtension,
} from "../../packages/cli/src/cinatra-dev-extensions.mjs";

/** The build argument both halves of this feature agree on, by exact name. */
export const FLEET_BUILD_ARG = "CINATRA_EXTENSION_FLEET";
export const FLEET_REQUIRED = "required";
export const FLEET_DEV = "dev";
export const FLEET_VALUES = [FLEET_REQUIRED, FLEET_DEV];

const SCOPED_PKG_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Normalize a fleet selector. An ABSENT or EMPTY value is `required`: docker
 * drops an unconsumed `--build-arg` with a warning and an explicitly emptied one
 * arrives as "", and neither may ever be read as a request for the dev fleet.
 * Any other value is a hard error — a typo must fail the build, not silently
 * produce a required-set image someone believes carries the fleet.
 */
export function parseExtensionFleet(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "") return FLEET_REQUIRED;
  if (!FLEET_VALUES.includes(raw)) {
    throw new Error(
      `[acquire-dev-fleet] unknown ${FLEET_BUILD_ARG} value "${raw}" — expected one of: ${FLEET_VALUES.join(", ")}.`,
    );
  }
  return raw;
}

/**
 * Read + strictly validate the committed dev-fleet lock. Every entry must carry
 * a well-formed scoped package name, an `owner/repo` slug and a 40-hex commit
 * SHA; duplicates are rejected. Throws listing every defect rather than
 * skipping — a malformed lock must never half-acquire.
 */
export function readDevFleetLock(lockPath) {
  if (!existsSync(lockPath)) {
    throw new Error(
      `[acquire-dev-fleet] lockfile not found: ${lockPath}. The committed ` +
        `${DEV_EXTENSIONS_LOCK_FILENAME} is the ONLY source the dev fleet is acquired from — regenerate ` +
        `it with \`node scripts/extensions/update-dev-extension-lock.mjs\` and commit it.`,
    );
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    throw new Error(`[acquire-dev-fleet] lockfile ${lockPath} is not valid JSON: ${err.message}`);
  }
  const packages = Array.isArray(doc?.packages) ? doc.packages : null;
  if (!packages || packages.length === 0) {
    throw new Error(
      `[acquire-dev-fleet] lockfile ${lockPath} has no "packages" entries — refusing to continue.`,
    );
  }
  const defects = [];
  const seen = new Set();
  for (const [i, p] of packages.entries()) {
    const tag = `packages[${i}]${p && typeof p.packageName === "string" ? ` (${p.packageName})` : ""}`;
    if (!p || typeof p !== "object") {
      defects.push(`${tag}: not an object`);
      continue;
    }
    if (typeof p.packageName !== "string" || !SCOPED_PKG_RE.test(p.packageName)) {
      defects.push(`${tag}: packageName must be a lowercase @scope/name`);
    } else if (seen.has(p.packageName)) {
      defects.push(`${tag}: duplicate packageName`);
    } else {
      seen.add(p.packageName);
    }
    if (typeof p.repo !== "string" || !REPO_SLUG_RE.test(p.repo) || p.repo.includes("..")) {
      defects.push(`${tag}: repo must be an "owner/name" GitHub slug`);
    }
    if (typeof p.resolvedSha !== "string" || !COMMIT_SHA_RE.test(p.resolvedSha)) {
      defects.push(`${tag}: resolvedSha must be a 40-hex lowercase commit SHA`);
    }
  }
  if (defects.length > 0) {
    throw new Error(`[acquire-dev-fleet] lockfile ${lockPath} failed validation:\n  - ${defects.join("\n  - ")}`);
  }
  return { schemaVersion: doc.schemaVersion ?? null, packages };
}

/** The package names the REQUIRED lock owns (empty set when it is absent). */
export function readRequiredLockNames(requiredLockPath) {
  try {
    const doc = JSON.parse(readFileSync(requiredLockPath, "utf8"));
    const packages = Array.isArray(doc?.packages) ? doc.packages : [];
    return new Set(packages.map((p) => p?.packageName).filter((n) => typeof n === "string"));
  } catch {
    return new Set();
  }
}

function readMarker(destDir) {
  const markerPath = path.join(destDir, ACQUISITION_MARKER_FILENAME);
  if (!existsSync(markerPath)) return null;
  try {
    const m = JSON.parse(readFileSync(markerPath, "utf8"));
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

function verifyPackageName(rawPackageJson, entry, label) {
  if (typeof rawPackageJson !== "string" || rawPackageJson.length === 0) {
    throw new Error(`[acquire-dev-fleet] ${label}: archive carries no root package.json`);
  }
  let manifest;
  try {
    manifest = JSON.parse(rawPackageJson);
  } catch (err) {
    throw new Error(`[acquire-dev-fleet] ${label}: root package.json is not valid JSON: ${err.message}`);
  }
  if (manifest.name !== entry.packageName) {
    throw new Error(
      `[acquire-dev-fleet] ${label}: package.json name "${manifest.name}" does not match the locked ` +
        `packageName "${entry.packageName}"`,
    );
  }
}

/**
 * Acquire the dev fleet into `<repoRoot>/extensions/<scope>/<name>`.
 *
 * `fleet: "required"` returns `{ skipped: true, reason: "required-fleet" }`
 * without reading a lock, making a request, or touching a file — the default
 * image build is exactly the build it is today.
 *
 * Returns `{ results: [{ pkgName, action, changed, dest }] }`.
 *
 * @param {{ repoRoot: string, fleet?: string, lockPath?: string, requiredLockPath?: string, fetchImpl?: typeof globalThis.fetch, log?: (message: string) => void }} options
 */
export async function acquireDevFleetExtensions({
  repoRoot,
  fleet = FLEET_REQUIRED,
  lockPath,
  requiredLockPath,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  if (!repoRoot) throw new Error("[acquire-dev-fleet] repoRoot is required");
  const selected = parseExtensionFleet(fleet);
  if (selected !== FLEET_DEV) {
    log(
      `- Dev-fleet acquisition: skipped (${FLEET_BUILD_ARG}=${selected}). The image carries the ` +
        `required set only — the road every real deployment takes.`,
    );
    return { skipped: true, reason: "required-fleet", results: [] };
  }

  const lock = readDevFleetLock(lockPath ?? path.join(repoRoot, DEV_EXTENSIONS_LOCK_FILENAME));
  const requiredNames = readRequiredLockNames(
    requiredLockPath ?? path.join(repoRoot, REQUIRED_EXTENSIONS_LOCK_FILENAME),
  );
  const overlap = lock.packages.map((p) => p.packageName).filter((n) => requiredNames.has(n)).sort();
  if (overlap.length > 0) {
    throw new Error(
      `[acquire-dev-fleet] ${overlap.length} package(s) are pinned in BOTH locks — the required lock is the ` +
        `sole authority for its packages and the dev road must never re-acquire over a verified required ` +
        `tree:\n  - ${overlap.join("\n  - ")}`,
    );
  }

  // Lazy, exactly as the required acquisition does it: `tar` is a root
  // workspace dependency and is not resolvable in the standalone runtime image.
  const tar = await import("tar");

  const results = [];
  let downloaded = 0;
  let verified = 0;
  log(`- Dev-fleet acquisition (${FLEET_BUILD_ARG}=${FLEET_DEV}): ${lock.packages.length} locked package(s)…`);

  for (const entry of lock.packages) {
    const dest = destDirForExtension(entry.packageName, {}, repoRoot);
    const label = `${entry.packageName} (${entry.repo}#${entry.resolvedSha.slice(0, 12)})`;

    if (existsSync(dest)) {
      const marker = readMarker(dest);
      if (!marker) {
        throw new Error(
          `[acquire-dev-fleet] ${dest} exists but is not acquisition-managed (no ` +
            `${ACQUISITION_MARKER_FILENAME}). Refusing to overwrite — this routine never clobbers a tree ` +
            `it does not own.`,
        );
      }
      if (marker.resolvedSha === entry.resolvedSha && typeof marker.treeSha256 === "string") {
        // A marker hit is a CLAIM, not proof — re-verify the content before trusting it.
        const actualTreeSha = computeTreeSha256FromDir(dest);
        if (actualTreeSha !== marker.treeSha256) {
          throw new Error(
            `[acquire-dev-fleet] ${label}: on-disk tree hash ${actualTreeSha} does not match the recorded ` +
              `${marker.treeSha256} (content changed after acquisition). Remove ${dest} and re-run.`,
          );
        }
        results.push({ pkgName: entry.packageName, action: "verified-existing", changed: false, dest });
        verified += 1;
        continue;
      }
      // Acquisition-managed but pinned elsewhere: the lock moved — re-acquire.
      // The stale tree stays in place until the replacement is verified.
    }

    const url = `https://codeload.github.com/${entry.repo}/tar.gz/${entry.resolvedSha}`;
    log(`  - ${label}: downloading…`);
    const gzBuffer = await downloadBounded(url, { fetchImpl });
    const tarBuffer = await gunzipBounded(gzBuffer);
    const { records, packageJsonRaw, violations } = await inspectTarball(tarBuffer, { tar });
    if (violations.length > 0) {
      throw new Error(
        `[acquire-dev-fleet] ${label}: unsafe archive from ${url}:\n  - ${violations.join("\n  - ")}`,
      );
    }
    verifyPackageName(packageJsonRaw, entry, label);
    const treeSha = foldTreeHash(records);

    const tmpDir = path.join(repoRoot, "extensions", `.devfleet-tmp-${process.pid}-${downloaded}`);
    rmSync(tmpDir, { recursive: true, force: true });
    try {
      await extractVerifiedTarball(tarBuffer, tmpDir, { tar });
      const extractedTreeSha = computeTreeSha256FromDir(tmpDir);
      if (extractedTreeSha !== treeSha) {
        throw new Error(
          `[acquire-dev-fleet] ${label}: extracted tree hash ${extractedTreeSha} does not match the ` +
            `inspected archive's ${treeSha} — refusing to install.`,
        );
      }
      writeFileSync(
        path.join(tmpDir, ACQUISITION_MARKER_FILENAME),
        JSON.stringify(
          {
            resolvedSha: entry.resolvedSha,
            treeSha256: treeSha,
            fleet: FLEET_DEV,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      );
      mkdirSync(path.dirname(dest), { recursive: true });
      // Swap. The previous tree is renamed ASIDE, not deleted, so a failed
      // rename into place can never leave the slot empty.
      const asideDir = path.join(repoRoot, "extensions", `.devfleet-old-${process.pid}-${downloaded}`);
      rmSync(asideDir, { recursive: true, force: true });
      let movedOldAside = false;
      if (existsSync(dest)) {
        renameSync(dest, asideDir);
        movedOldAside = true;
      }
      try {
        renameSync(tmpDir, dest);
      } catch (renameErr) {
        if (movedOldAside) renameSync(asideDir, dest);
        throw renameErr;
      }
      if (movedOldAside) rmSync(asideDir, { recursive: true, force: true });
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
    results.push({ pkgName: entry.packageName, action: "downloaded", changed: true, dest });
    downloaded += 1;
  }

  log(`- Dev-fleet acquisition: OK (${downloaded} downloaded, ${verified} verified in place).`);
  return { results };
}

function parseArgs(argv) {
  const args = { fleet: process.env[FLEET_BUILD_ARG], repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--fleet") args.fleet = argv[++i];
    else if (argv[i] === "--repo-root") args.repoRoot = argv[++i];
  }
  return args;
}

// CLI entrypoint (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  await acquireDevFleetExtensions({ repoRoot: args.repoRoot, fleet: args.fleet });
}
