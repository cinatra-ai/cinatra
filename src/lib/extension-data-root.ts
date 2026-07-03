// The ONE configurable extension data root (cinatra#790/#791).
//
// Replaces the hardcoded `DEFAULT_PACKAGE_STORE_PATH` ("/data/extensions/packages")
// as the root every runtime-store surface (materializer, boot loader, hot-install
// activation, read model, artifact rescan, install resolution) resolves against.
// The V2 content-addressed layout lives UNDER this root, kind-segregated:
// `<root>/<kind>/<slug>/<digest>/` (see extension-package-store-core.ts).
//
// Resolution precedence (ops-deploy determinism rationale, ops#436): the `CINATRA_EXTENSION_DATA_ROOT` env var,
// when set non-empty, WINS over the DB metadata key and the default. The deploy
// environment owns the on-disk runtime-store topology (the mounted data volume),
// and a stale `extension_data_root` row left in the DB must never split the host
// off the deploy-managed volume. Dev/unit contexts set neither and get the
// container default.

import path from "node:path";
import { readMetadataValueFromDatabase, writeMetadataValueToDatabase } from "@/lib/database";

/** Highest-precedence source (deploy determinism). */
export const EXTENSION_DATA_ROOT_ENV = "CINATRA_EXTENSION_DATA_ROOT";

/** DB metadata key (admin-configurable; loses to the env var). */
export const EXTENSION_DATA_ROOT_METADATA_KEY = "extension_data_root";

/** Default runtime data root inside the container's `/data` volume. */
export const DEFAULT_EXTENSION_DATA_ROOT = "/data/extensions";

/** The configured extension data root: env > DB metadata > default. */
export function readExtensionDataRoot(): string {
  const envValue = process.env[EXTENSION_DATA_ROOT_ENV];
  if (typeof envValue === "string") {
    const trimmedEnv = envValue.trim();
    if (trimmedEnv) return trimmedEnv;
  }
  // The DB metadata read degrades to the default when the store is not usable
  // in this context (very-early boot, schema not ready) — the root must always
  // resolve; a deploy that needs a non-default root pins it via the env var.
  let stored: string | null;
  try {
    stored = readMetadataValueFromDatabase<string | null>(EXTENSION_DATA_ROOT_METADATA_KEY, null);
  } catch {
    stored = null;
  }
  if (typeof stored !== "string") return DEFAULT_EXTENSION_DATA_ROOT;
  const trimmed = stored.trim();
  return trimmed || DEFAULT_EXTENSION_DATA_ROOT;
}

export function writeExtensionDataRoot(value: string): void {
  writeMetadataValueToDatabase(EXTENSION_DATA_ROOT_METADATA_KEY, value);
}

/** The configured root as an ABSOLUTE path (relative values resolve against cwd). */
export function resolveExtensionDataRoot(): string {
  const cfg = readExtensionDataRoot();
  return path.isAbsolute(cfg) ? cfg : path.join(process.cwd(), cfg);
}
