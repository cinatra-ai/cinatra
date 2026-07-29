#!/usr/bin/env node
// Pre-install clone-back for the companion extension repos (CI + `make setup`).
//
// The bundled `extensions/<scope>/<name>/` source tree is not committed to this
// tree — it lives in the companion per-extension
// repos (cinatra-ai/<slug>). The host build/typecheck and the IoC gates still
// need that source on disk (tsconfig path aliases, next transpilePackages, and
// the extension-import-ban inventory scan). This script clones it back BEFORE
// `pnpm install` — in CI and in the dev path of `scripts/setup.sh` — because
// the root package.json declares `workspace:*` deps on the extension packages,
// so a fresh clone's install without the tree fails resolution outright
// (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND; cinatra#109/#110).
//
// It is deliberately FOCUSED and pre-install-safe: pure git/fs (reuses
// `syncCinatraDevExtensions`), no DB / Nango / dev-app work (that's `setup dev`),
// and no workspace install required (relative .mjs + node builtins + `git`).
//
// FAIL-CLOSED, by design — the whole point is to keep the extension gates
// HONEST. If the `cinatra.devExtensions` manifest is empty, or fewer than the
// declared number of extension dirs materialize (or a materialized
// package.json names a different package), it exits non-zero. Without this
// the IoC gates would scan an empty tree and pass VACUOUSLY (a silent
// protection regression).
//
// Modes (cinatra#141): `--pinned` (what CI runs via
// .github/actions/clone-extensions) checks every repo out DETACHED at the sha
// committed in cinatra-required-extensions.lock.json /
// cinatra-dev-extensions.lock.json, so host CI validates a reproducible,
// committed extension universe. Without the flag (local `make setup`, the
// floating-HEAD canary) it tracks branch tips as before.
import path from "node:path";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  syncCinatraDevExtensions,
  readDevExtensionsConfig,
} from "../../packages/cli/src/cinatra-dev-extensions.mjs";

const repoRoot = process.cwd();

const config = readDevExtensionsConfig(repoRoot);
const expected = config ? Object.keys(config).length : 0;
if (expected === 0) {
  console.error(
    "[ci sync-dev-extensions] FAIL: `cinatra.devExtensions` is empty/absent in package.json.\n" +
      "  CI must clone the companion extension repos so the build + IoC gates run against real\n" +
      "  source — refusing to continue (an empty extensions/ tree would pass the gates vacuously).",
  );
  process.exit(1);
}

const res = await syncCinatraDevExtensions({
  repoRoot,
  targetRoot: repoRoot,
  argv: process.argv.slice(2),
  log: (m) => console.log(m),
});

if (res?.skipped) {
  console.error(`[ci sync-dev-extensions] FAIL: sync skipped (${res.reason}).`);
  process.exit(1);
}

// Verify every declared extension actually materialized with a package.json
// whose `name` matches the declared key — presence alone would let a
// mis-pinned/mis-targeted repo count as the package it isn't.
const extRoot = path.join(repoRoot, "extensions");
const missing = [];
for (const name of Object.keys(config)) {
  const m = String(name).match(/^@([^/]+)\/(.+)$/);
  if (!m) {
    missing.push(`${name} (unparseable scoped name)`);
    continue;
  }
  const manifestPath = path.join(extRoot, m[1], m[2], "package.json");
  if (!existsSync(manifestPath)) {
    missing.push(name);
    continue;
  }
  let manifestName;
  try {
    manifestName = JSON.parse(readFileSync(manifestPath, "utf8")).name;
  } catch {
    missing.push(`${name} (unreadable package.json)`);
    continue;
  }
  if (manifestName !== name) missing.push(`${name} (materialized package.json names "${manifestName}")`);
}

const present = expected - missing.length;
if (missing.length > 0) {
  console.error(
    `[ci sync-dev-extensions] FAIL: ${present}/${expected} extension repos present after sync. Missing:\n  - ${missing.join("\n  - ")}`,
  );
  process.exit(1);
}

// Prune-on-sync for REMOVED `cinatra.devExtensions` entries (cinatra#2090 S3).
// The sync above materializes declared repos but never deletes one that left
// the manifest — and both the skill resolver scan and the dev watcher walk
// every on-disk extension dir, so a stale checkout (e.g. the retired
// assistant-skills pack after its consolidation) keeps re-registering skills
// that no declared package ships. Fail-closed posture:
//   - a stale dir that is a CLEAN git checkout is removed (it is reproducible
//     from its remote — nothing local is lost);
//   - a stale dir with LOCAL modifications (or that is not a git checkout at
//     all) FAILS the sync by name, so a developer's in-progress work is never
//     deleted silently and a non-reproducible tree never survives unnoticed.
const declaredDirs = new Set(
  Object.keys(config).map((name) => {
    const m = String(name).match(/^@([^/]+)\/(.+)$/);
    return m ? path.join(m[1], m[2]) : null;
  }).filter(Boolean),
);
const stale = [];
const pruned = [];
if (existsSync(extRoot)) {
  for (const vendor of readdirSync(extRoot, { withFileTypes: true })) {
    if (!vendor.isDirectory() || vendor.name.startsWith(".") || vendor.name === "node_modules") continue;
    const vendorDir = path.join(extRoot, vendor.name);
    for (const pkg of readdirSync(vendorDir, { withFileTypes: true })) {
      if (!pkg.isDirectory() || pkg.name.startsWith(".") || pkg.name === "node_modules") continue;
      if (declaredDirs.has(path.join(vendor.name, pkg.name))) continue;
      const pkgDir = path.join(vendorDir, pkg.name);
      let clean = false;
      try {
        // The dir must be its OWN git checkout: `git -C <non-repo-dir>`
        // discovers the PARENT repository (the cinatra worktree), whose clean
        // status must never vouch for deleting a child that is not a repo at
        // all. Require the discovered toplevel to BE the extension dir.
        const toplevel = execFileSync("git", ["-C", pkgDir, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          timeout: 60_000,
        }).trim();
        if (realpathSync(toplevel) === realpathSync(pkgDir)) {
          const status = execFileSync("git", ["-C", pkgDir, "status", "--porcelain"], {
            encoding: "utf8",
            timeout: 60_000,
          });
          clean = status.trim().length === 0;
        }
      } catch {
        clean = false; // not a git checkout / git failed → never auto-delete
      }
      if (clean) {
        rmSync(pkgDir, { recursive: true, force: true });
        pruned.push(path.join(vendor.name, pkg.name));
      } else {
        stale.push(path.join(vendor.name, pkg.name));
      }
    }
  }
}
for (const p of pruned) {
  console.log(`[ci sync-dev-extensions] pruned stale extension checkout extensions/${p} (no longer in cinatra.devExtensions).`);
}
if (stale.length > 0) {
  console.error(
    `[ci sync-dev-extensions] FAIL: stale extension dir(s) not in cinatra.devExtensions and NOT a clean git checkout — ` +
      `remove them manually (they would keep re-registering undeclared skills):\n  - ${stale.map((s) => `extensions/${s}`).join("\n  - ")}`,
  );
  process.exit(1);
}

console.log(`[ci sync-dev-extensions] OK: ${present}/${expected} extension repos cloned into extensions/.`);
