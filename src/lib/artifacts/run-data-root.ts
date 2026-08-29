// THE ONE configurable RUN data root (cinatra#3030, epic #3023 W6; plan (C)
// item 0.21).
//
//   "The run folder: `data/agents/runs/<organisation>/<run>/` under the same
//    data root as the artifact store — resolved like the artifact root
//    (environment, then the stored setting, then the default), guarded at boot,
//    path-confined with symlinks refused, and placed where the artifact store is
//    placed: one root per deployment, on shared storage where the application
//    runs on more than one host."
//
// A deliberate mirror of `./artifact-data-root.ts` (and, through it, of
// `@/lib/extension-data-root`): the SAME env > DB metadata > default precedence
// and the same deploy-determinism rationale. It is a THIRD root and never nests
// under either sibling — plan §8.1 names it as such — because what it holds is a
// STAGING COPY with a retention tier of its own (§2: "the folder is kept for a
// bounded time and is never the artifact's home"), while artifact bytes are
// durable organisation data collected by reachability alone.
//
// The DEFAULT mirrors the artifact root's: the historical CWD-RELATIVE
// `data/agents/runs`, so dev and test keep an on-disk layout that needs no
// configuration; a deployment pins the mounted volume through the env var.

import path from "node:path";
import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";

/** Highest-precedence source (deploy determinism). */
export const RUN_DATA_ROOT_ENV = "CINATRA_RUN_DATA_ROOT";

/** DB metadata key (admin-configurable; loses to the env var). */
export const RUN_DATA_ROOT_METADATA_KEY = "run_data_root";

/** Default: CWD-relative `data/agents/runs` — the path item 0.21 names. */
export const DEFAULT_RUN_DATA_ROOT = path.join("data", "agents", "runs");

/** The configured run data root: env > DB metadata > default. */
export function readRunDataRoot(): string {
  const envValue = process.env[RUN_DATA_ROOT_ENV];
  if (typeof envValue === "string") {
    const trimmedEnv = envValue.trim();
    if (trimmedEnv) return trimmedEnv;
  }
  // The DB metadata read degrades to the default when the store is not usable in
  // this context (very-early boot, schema not ready, unit tests) — the root must
  // always resolve; a deployment that needs a non-default root pins the env var.
  let stored: string | null;
  try {
    stored = readMetadataValueFromDatabase<string | null>(RUN_DATA_ROOT_METADATA_KEY, null);
  } catch {
    stored = null;
  }
  if (typeof stored !== "string") return DEFAULT_RUN_DATA_ROOT;
  const trimmed = stored.trim();
  return trimmed || DEFAULT_RUN_DATA_ROOT;
}

export function writeRunDataRoot(value: string): void {
  writeMetadataValueToDatabase(RUN_DATA_ROOT_METADATA_KEY, value);
}

/** The configured root as an ABSOLUTE, NORMALIZED path (relative values resolve
 *  against cwd). `path.resolve` also strips a trailing separator — load-bearing
 *  for the containment guard, which compares against `root + path.sep` and would
 *  reject every path under a root configured with one. */
export function resolveRunDataRoot(): string {
  const cfg = readRunDataRoot();
  return path.isAbsolute(cfg) ? path.resolve(cfg) : path.resolve(process.cwd(), cfg);
}
