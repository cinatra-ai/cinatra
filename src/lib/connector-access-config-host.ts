import "server-only";

// ---------------------------------------------------------------------------
// Host config reader for the connector access declaration (cinatra#951).
//
// Reads a materialized package's `cinatra/config.json` from its SRI-verified
// store dir and resolves it through the SINGLE authoritative validator
// (`@cinatra-ai/sdk-extensions/access-config`) with INSTALL-surface
// semantics:
//
//   - kind !== "connector" → null (the declaration is a connector concern);
//   - file present → strict fail-closed parse (unknown keys anywhere,
//     both/neither of default|only, non-vocabulary scope, protected-slug
//     violation ALL throw → the install pipeline aborts before any durable
//     mutation);
//   - file absent → the absence rule (`default:"admin"`; a protected slug
//     resolves its FORCED `only:"admin"` — never looser — so
//     already-published protected tarballs stay installable until the W4
//     fleet republish);
//   - a present-but-unreadable/malformed-JSON file → throw (fail-closed:
//     a corrupt declaration must never silently resolve to the default).
//
// The resolved declaration is CACHED on the canonical registration record
// (`installed_extension.access_declaration`) at the pipeline's finalize seam
// (`recordExtensionAccessDeclaration`) and by the static-bundle lifecycle at
// boot registration — the W2 resolver reads the CACHE, never the file.
// ---------------------------------------------------------------------------

import {
  ConnectorAccessConfigError,
  parseConnectorAccessConfig,
  resolveAbsentConnectorAccessConfig,
  type ResolvedConnectorAccessDeclaration,
} from "@cinatra-ai/sdk-extensions/access-config";

export type { ResolvedConnectorAccessDeclaration };

/**
 * Resolve the access declaration for a materialized package dir. Returns
 * `null` for non-connector kinds; THROWS `ConnectorAccessConfigError` on any
 * fail-closed violation (the caller aborts the install/registration).
 */
export async function readConnectorAccessDeclarationFromStore(
  storeDir: string,
): Promise<ResolvedConnectorAccessDeclaration | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    // No manifest → not a readable package; the materializer/loader owns that
    // failure. The access reader has nothing to declare on.
    return null;
  }
  let manifest: { name?: unknown; cinatra?: { kind?: unknown } };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    return null; // Malformed package.json is the materializer's fail domain.
  }
  if (manifest.cinatra?.kind !== "connector") return null;
  const packageName = typeof manifest.name === "string" ? manifest.name : "";

  const configPath = path.join(storeDir, "cinatra", "config.json");
  let configRaw: string | null = null;
  try {
    configRaw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Genuinely absent → the absence rule (protected slugs resolve FORCED).
      return resolveAbsentConnectorAccessConfig({ packageName, surface: "install" });
    }
    // Present but unreadable (permissions, IO) — fail closed, never default.
    throw new ConnectorAccessConfigError(
      `cinatra/config.json for ${packageName} exists but is unreadable: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw);
  } catch (err) {
    throw new ConnectorAccessConfigError(
      `cinatra/config.json for ${packageName} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return parseConnectorAccessConfig(parsed, { packageName });
}
