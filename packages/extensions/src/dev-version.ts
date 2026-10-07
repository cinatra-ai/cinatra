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
import { isSuppliedDigestSource } from "./canonical-types";
import type { ExtensionSource, ExtensionSourceLocal, InstalledExtension } from "./canonical-types";

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

/**
 * One row the record left alone, and why. `sourceType` and `hasContentDigest`
 * are the two facts the decision turned on, so a scan line can state the reason
 * without a second read of the row.
 */
export type DevVersionSkippedRow = {
  id: string;
  kind: string;
  sourceType: string;
  hasContentDigest: boolean;
  reason: string;
};

export type RecordDevResult =
  | { ok: true; updated: number; skipped: DevVersionSkippedRow[]; version: string }
  | { ok: false; reason: string };

/**
 * The provenance a development record may NOT rewrite (cinatra#3788).
 *
 * An upload and a registry install both record where their bytes came from, and
 * the install road reads that record back: the supplied store payload resolves
 * only while `isSuppliedDigestSource` holds, and the registry anchor only while
 * the source stays `verdaccio`. Returns the skip decision, or null when the row
 * is a source checkout or a static bundle and the record owns it.
 */
function devRecordSkipFor(row: InstalledExtension): DevVersionSkippedRow | null {
  const source = row.source as ExtensionSource | null | undefined;
  const sourceType = (source as { type?: string } | null | undefined)?.type ?? "unknown";
  const hasContentDigest =
    typeof (source as { contentDigest?: unknown } | null | undefined)?.contentDigest === "string";
  const base = { id: row.id, kind: row.kind ?? "unknown", sourceType, hasContentDigest };
  if (isSuppliedDigestSource(source)) {
    return {
      ...base,
      reason: "the row carries supplied (uploaded) provenance, which only the install road may rewrite",
    };
  }
  if (sourceType === "verdaccio") {
    return {
      ...base,
      reason: "the row carries registry provenance, which only the install road may rewrite",
    };
  }
  return null;
}

/**
 * Record a dev recompile against the canonical manifest. Updates the rows of
 * the package that already carry an IN-TREE provenance (a source checkout or a
 * static bundle) to a `local` source carrying the dev version + commit
 * tree-hash. Idempotent: re-running with the same SHA yields the same source.
 *
 * A row whose provenance is an upload or a registry install is SKIPPED, for
 * every kind (cinatra#3788). Such a row records which bytes the operator
 * delivered, and the install road reads that record back to find them; the
 * watcher only observed a folder, so its reading is never the one to overwrite
 * a delivery with. The skipped rows come back in the result so the caller can
 * say what it left alone.
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
  const skipped: DevVersionSkippedRow[] = [];
  for (const row of rows) {
    const skip = devRecordSkipFor(row);
    if (skip) {
      skipped.push(skip);
      continue;
    }
    await sourceSwitchExtension(row.id, source, {
      actor: { source: opts.actorSource ?? "dev-compile" },
      reason: `dev recompile @ ${version}`,
    });
    updated++;
  }
  return { ok: true, updated, skipped, version };
}
