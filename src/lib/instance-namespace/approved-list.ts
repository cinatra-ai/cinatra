// -----------------------------------------------------------------------------
// Approved-instance-namespaces loader.
//
// Reads a config file whose path is given by CINATRA_APPROVED_INSTANCE_NAMESPACES_FILE.
// Each non-empty, non-comment line is one EXACT namespace that bypasses the
// reserved-substring guard in validator.ts.
//
// Used for the platform owner's own instances (e.g. cinatra-ai) and any other
// names the operator has pre-approved on the registry side. Mirroring the
// same `approved-reserved-namespaces.txt` config file that the registry vhost
// reads keeps the two sides authoritatively in sync — there is no way the
// cinatra app accepts a namespace the registry would reject.
//
// Pure I/O on first call per process; cached thereafter. Re-reads require a
// process restart, same as every other env-driven config in this image.
// -----------------------------------------------------------------------------

import { readFileSync } from "node:fs";

let cache: readonly string[] | undefined;

export function getApprovedInstanceNamespaces(): readonly string[] {
  if (cache !== undefined) return cache;
  const filePath = process.env.CINATRA_APPROVED_INSTANCE_NAMESPACES_FILE?.trim();
  if (!filePath) {
    cache = [];
    return cache;
  }
  try {
    cache = readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    // File missing / unreadable — fall back to the conservative empty list.
    // The validator still enforces RESERVED_SUBSTRINGS so no security gap.
    cache = [];
  }
  return cache;
}
