// The ONE configurable ARTIFACT data root (cinatra#926, epic #922).
//
// A deliberate mirror of `src/lib/extension-data-root.ts` (cinatra#791): the
// same env > DB metadata > default precedence and the same deploy-determinism
// rationale. It is a SEPARATE root from `CINATRA_EXTENSION_DATA_ROOT` and
// never nests under it: extensions are a REBUILDABLE CACHE (rematerializable
// from the locked source), artifact bytes are DURABLE ORG USER DATA (GC is
// DB-reachability only; backup policy differs).
//
// Resolution precedence: the `CINATRA_ARTIFACT_DATA_ROOT` env var, when set
// non-empty, WINS over the DB metadata key and the default. The deploy
// environment owns the on-disk topology (the mounted data volume), and a
// stale `artifact_data_root` row left in the DB must never split the host
// off the deploy-managed volume.
//
// Unlike the extension root, the DEFAULT is the historical CWD-RELATIVE
// `data/artifacts` — dev/test keep today's on-disk layout unchanged; prod
// opts into `/data/artifacts` (container volume) via the env var. This is a
// config-only move: `storage_key`s are ROOT-RELATIVE, so changing the root
// requires zero key rewrites.

import path from "node:path";
import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";

/** Highest-precedence source (deploy determinism). */
export const ARTIFACT_DATA_ROOT_ENV = "CINATRA_ARTIFACT_DATA_ROOT";

/** DB metadata key (admin-configurable; loses to the env var). */
export const ARTIFACT_DATA_ROOT_METADATA_KEY = "artifact_data_root";

/** Historical default: CWD-relative `data/artifacts` (dev/test unchanged). */
export const DEFAULT_ARTIFACT_DATA_ROOT = path.join("data", "artifacts");

/** The configured artifact data root: env > DB metadata > default. */
export function readArtifactDataRoot(): string {
  const envValue = process.env[ARTIFACT_DATA_ROOT_ENV];
  if (typeof envValue === "string") {
    const trimmedEnv = envValue.trim();
    if (trimmedEnv) return trimmedEnv;
  }
  // The DB metadata read degrades to the default when the store is not usable
  // in this context (very-early boot, schema not ready, unit tests) — the
  // root must always resolve; a deploy that needs a non-default root pins it
  // via the env var.
  let stored: string | null;
  try {
    stored = readMetadataValueFromDatabase<string | null>(ARTIFACT_DATA_ROOT_METADATA_KEY, null);
  } catch {
    stored = null;
  }
  if (typeof stored !== "string") return DEFAULT_ARTIFACT_DATA_ROOT;
  const trimmed = stored.trim();
  return trimmed || DEFAULT_ARTIFACT_DATA_ROOT;
}

export function writeArtifactDataRoot(value: string): void {
  writeMetadataValueToDatabase(ARTIFACT_DATA_ROOT_METADATA_KEY, value);
}

/** The configured root as an ABSOLUTE, NORMALIZED path (relative values
 *  resolve against cwd). `path.resolve` also strips a trailing separator —
 *  load-bearing for the blob store's containment guard, which compares
 *  against `root + path.sep` and would reject every key under a root
 *  configured as `/data/artifacts/`. */
export function resolveArtifactDataRoot(): string {
  const cfg = readArtifactDataRoot();
  return path.isAbsolute(cfg) ? path.resolve(cfg) : path.resolve(process.cwd(), cfg);
}
