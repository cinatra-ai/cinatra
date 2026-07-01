// Agent install path helper.
// Reads/writes the configured agent install directory from the metadata table
// and resolves it to an absolute filesystem path. Agent package installation
// uses this helper to target a configurable subtree.
//
// The helper trusts that the stored value was validated at write time by the
// caller, including path-traversal validation in the server action. This module
// performs only the read/write/resolve mechanics.
//
// Resolution precedence (cinatra-ai/ops#436): the `CINATRA_AGENT_INSTALL_DIR`
// env var, when set, WINS over the DB metadata key and the default. Deploy
// determinism is the reason env beats metadata: the deploy environment owns the
// on-disk agent-OAS topology (the dir WayFlow mounts `:/agents:ro`), and a stale
// `agent_install_path` row left in the DB must NOT be able to split the host app
// off the deploy-managed directory — both the host process AND the WayFlow mount
// must resolve to the SAME tree the deploy materializes the required set into.
// Dev sets neither, so the historical default (`<cwd>/extensions`) is unchanged.

import path from "node:path";
import {
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";

const METADATA_KEY = "agent_install_path";
// Env override (ops#436): highest-precedence source for deploy determinism.
const ENV_KEY = "CINATRA_AGENT_INSTALL_DIR";
// Default source package root for installed agent extensions.
const DEFAULT_PATH = "extensions";

export function readAgentInstallPath(): string {
  // Env override wins (deploy determinism — see module header).
  const envValue = process.env[ENV_KEY];
  if (typeof envValue === "string") {
    const trimmedEnv = envValue.trim();
    if (trimmedEnv) return trimmedEnv;
  }
  const stored = readMetadataValueFromDatabase<string | null>(METADATA_KEY, null);
  if (typeof stored !== "string") {
    return DEFAULT_PATH;
  }
  const trimmed = stored.trim();
  return trimmed || DEFAULT_PATH;
}

export function writeAgentInstallPath(value: string): void {
  writeMetadataValueToDatabase(METADATA_KEY, value);
}

export function resolveAgentInstallDir(): string {
  const cfg = readAgentInstallPath();
  return path.isAbsolute(cfg) ? cfg : path.join(process.cwd(), cfg);
}
