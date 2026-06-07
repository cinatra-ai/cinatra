import { readFileSync } from "node:fs";
import path from "node:path";

import { defaultRepoSyncDeps, envOverrideVarFor, syncOneRepo } from "./dev-repo-sync.mjs";

// ---------------------------------------------------------------------------
// Dev-app clone sync.
//
// The WordPress plugin (cinatra-ai/wordpress-plugin) and Drupal module
// (cinatra-ai/drupal-module) are EXTERNAL apps' integration code — they live in
// their own git repos and ship to WordPress.org / Drupal.org, NOT cinatra's
// marketplace. For the dev docker stack, `cinatra setup {dev,branch,clone}`
// clones / fast-forwards them into fixed paths under `dev/` (declared in
// package.json `cinatra.devApps`). The source of truth is the extracted repos,
// NOT this tree (the clone paths are gitignored).
//
// Flags: --skip-dev-apps (skip entirely),
//        --force-dev-apps (override a DIRTY tree only).
// Per-repo URL overrides via env: CINATRA_<NAME>_REPO_URL (HTTPS or SSH).
//
// The five-state tree-safety model + git utilities live in `dev-repo-sync.mjs`.
// ---------------------------------------------------------------------------

export function readDevAppsConfig(repoRoot, readFile = readFileSync) {
  try {
    const pkg = JSON.parse(readFile(path.join(repoRoot, "package.json"), "utf8"));
    const config = pkg?.cinatra?.devApps;
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

/**
 * Sync all configured dev apps into `targetRoot`.
 * - repoRoot: where package.json (the config) lives.
 * - targetRoot: where the clones are materialized (repo root for `setup dev`,
 *   the worktree path for `setup branch` / `setup clone`).
 */
export async function syncDevApps({
  repoRoot,
  targetRoot,
  argv = [],
  env = process.env,
  log = console.log,
  deps,
} = {}) {
  if (argv.includes("--skip-dev-apps")) {
    log("- Dev apps: skipped (--skip-dev-apps).");
    return { skipped: true, reason: "flag" };
  }
  const config = readDevAppsConfig(repoRoot, deps?.readFile);
  if (!config || Object.keys(config).length === 0) {
    return { skipped: true, reason: "no-config" };
  }
  const force = argv.includes("--force-dev-apps");
  const realDeps = deps ?? defaultRepoSyncDeps();
  const results = [];
  log("- Dev apps:");
  for (const [pkgName, spec] of Object.entries(config)) {
    const url = env[envOverrideVarFor(pkgName)] || spec.url;
    const branch = spec.branch || "main";
    const dest = path.resolve(targetRoot, spec.path);
    results.push(
      syncOneRepo({
        pkgName,
        url,
        branch,
        dest,
        force,
        deps: realDeps,
        log,
        forceFlagHint: "--force-dev-apps",
        stashLabel: "cinatra --force-dev-apps",
      }),
    );
  }
  return { results };
}
