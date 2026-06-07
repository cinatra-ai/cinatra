// Agent install path helper.
// Reads/writes the configured agent install directory from the metadata table
// and resolves it to an absolute filesystem path. Agent package installation
// uses this helper to target a configurable subtree.
//
// The helper trusts that the stored value was validated at write time by the
// caller, including path-traversal validation in the server action. This module
// performs only the read/write/resolve mechanics.

import path from "node:path";
import {
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";

const METADATA_KEY = "agent_install_path";
// Default source package root for installed agent extensions.
const DEFAULT_PATH = "extensions";

export function readAgentInstallPath(): string {
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
