// Dev compile-to-DB version handling.
//
// In dev mode (CINATRA_RUNTIME_MODE=development), a file change in an
// extension triggers a recompile that updates the canonical manifest row's
// source provenance in place with version `0.0.0-dev.<sha>`. No Verdaccio
// publish is required. This is idempotent: re-running yields the same row.
import "server-only";

import { execSync } from "node:child_process";

import {
  readInstalledExtensionsByPackageName,
} from "./canonical-store";
import { sourceSwitchExtension } from "./lifecycle-primitive";
import type { ExtensionSourceLocal } from "./canonical-types";

const DEV_VERSION_PREFIX = "0.0.0-dev.";

/**
 * Resolve the current git short SHA. Returns "unknown" if git is unavailable
 * (the caller still gets a stable, recognisably-dev version string).
 */
export function currentGitSha(cwd: string = process.cwd()): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export function devVersionForSha(sha: string): string {
  return `${DEV_VERSION_PREFIX}${sha}`;
}

export function isDevVersion(version: string): boolean {
  return version.startsWith(DEV_VERSION_PREFIX);
}

export function shaFromDevVersion(version: string): string | null {
  return isDevVersion(version) ? version.slice(DEV_VERSION_PREFIX.length) : null;
}

export type RecordDevResult =
  | { ok: true; updated: number; version: string }
  | { ok: false; reason: string };

/**
 * Record a dev recompile against the canonical manifest. Updates every
 * row for the package to a `local` source carrying the dev version + commit
 * tree-hash. Idempotent: re-running with the same SHA yields the same source.
 *
 * Only runs in dev mode (advisory no-op in production; production uses tag-publish).
 */
export async function recordDevExtensionVersion(
  packageName: string,
  sourcePath: string,
  opts: { sha?: string; actorSource?: string } = {},
): Promise<RecordDevResult> {
  if (process.env.CINATRA_RUNTIME_MODE !== "development") {
    return { ok: false, reason: "recordDevExtensionVersion is a development-mode-only operation" };
  }
  const sha = opts.sha ?? currentGitSha();
  const version = devVersionForSha(sha);
  const rows = await readInstalledExtensionsByPackageName(packageName);
  if (rows.length === 0) {
    return { ok: false, reason: `no installed_extension row for ${packageName}` };
  }
  const source: ExtensionSourceLocal = {
    type: "local",
    path: sourcePath,
    resolvedCommitOrTreeHash: sha,
  };
  let updated = 0;
  for (const row of rows) {
    await sourceSwitchExtension(row.id, source, {
      actor: { source: opts.actorSource ?? "dev-compile" },
      reason: `dev recompile @ ${version}`,
    });
    updated++;
  }
  return { ok: true, updated, version };
}
