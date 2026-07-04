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

// ---------------------------------------------------------------------------
// Install-pipeline seam (cinatra#951) — the access-declaration vertical slice
// of `InstallPipelineDeps` plus the pipeline-side helpers that thread it:
// EARLY fail-closed read (install refused fully inert), FINALIZE-seam
// persistence, and the prior-declaration restore both unwind paths run on a
// failed UPDATE. Extracted from extension-install-pipeline.ts (file-size
// ratchet); the pipeline stays the only caller and keeps full DI.
// ---------------------------------------------------------------------------

export type ConnectorAccessDeclarationInstallDeps = {
  /**
   * Resolve the connector access declaration from the materialized store dir
   * (cinatra#951) — the fail-closed read of `cinatra/config.json` through the
   * SDK validator (`@cinatra-ai/sdk-extensions/access-config`,
   * INSTALL-surface absence semantics). Returns null for non-connector
   * kinds. Runs EARLY (with the host-compat gate, before any durable
   * mutation, same inertness/GC contract as readDependencyEdges) so a refused
   * declaration is fully inert; a throw aborts the install. Wired with a
   * null-returning default in unit tests; the default factory always wires
   * the host reader (`readConnectorAccessDeclarationFromStore`).
   */
  readAccessDeclaration: (storeDir: string) => Promise<ResolvedConnectorAccessDeclaration | null>;
  /**
   * Persist the resolved declaration onto the canonical install row at the
   * SAME (package, org) scope, at the FINALIZE SEAM next to
   * `persistDependencyEdges` (cinatra#951) — so no connector install-op
   * reaches `finalized` without a cached declaration. The default factory
   * wires the sanctioned canonical writer
   * (`recordExtensionAccessDeclaration`).
   */
  persistAccessDeclaration: (input: {
    packageName: string;
    orgId: string | null;
    declaration: ResolvedConnectorAccessDeclaration | null;
  }) => Promise<void>;
  /**
   * Capture the CURRENT canonical row's cached declaration for the
   * (package, org) BEFORE the finalize seam overwrites it — restored by BOTH
   * unwind paths on a failed UPDATE, exactly like `readCurrentDependencies`
   * (a failed update must never leave the NEW manifest's declaration cached
   * against the still-live OLD install). Returns null when no live row / no
   * cached declaration exists.
   */
  readCurrentAccessDeclaration: (
    packageName: string,
    orgId: string | null,
  ) => Promise<ResolvedConnectorAccessDeclaration | null>;
};

type AccessDeclarationReadDeps = Partial<Pick<ConnectorAccessDeclarationInstallDeps, "readAccessDeclaration">> & {
  gcStoreDir?: (storeDir: string) => Promise<void>;
};

/**
 * EARLY fail-closed read for the install pipeline: an invalid declaration
 * (unknown keys anywhere, both/neither of default|only, a non-vocabulary
 * scope, a protected-slug violation) THROWS — BEFORE the pipeline's first
 * durable mutation, so the install/update is refused fully inert — and the
 * just-materialized dir is GC'd best-effort UNLESS it IS the live install's
 * dir (`isLiveDigest`, the same-digest re-install guard). `null` = not a
 * connector. The declaration persists LATE, at the finalize seam.
 */
export async function readAccessDeclarationInertly(
  deps: AccessDeclarationReadDeps,
  storeDir: string,
  isLiveDigest: boolean,
): Promise<ResolvedConnectorAccessDeclaration | null> {
  if (!deps.readAccessDeclaration) return null;
  try {
    return await deps.readAccessDeclaration(storeDir);
  } catch (err) {
    if (deps.gcStoreDir && !isLiveDigest) {
      try {
        await deps.gcStoreDir(storeDir);
      } catch {
        /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
      }
    }
    throw err;
  }
}

/**
 * DECLARATION PERSISTENCE at the FINALIZE SEAM (cinatra#951): the resolved
 * connector access declaration (read EARLY, fail-closed) lands on the
 * canonical row with the same guarantees as the dependency edges — a
 * `finalized` connector install-op implies a cached declaration. A throw
 * aborts the finalize (the pipeline's existing unwind handles it).
 * Non-connector kinds resolve null and skip the write.
 */
export async function persistAccessDeclarationAtFinalize(
  deps: Partial<Pick<ConnectorAccessDeclarationInstallDeps, "persistAccessDeclaration">>,
  input: {
    packageName: string;
    orgId: string | null;
    declaration: ResolvedConnectorAccessDeclaration | null;
  },
): Promise<void> {
  if (input.declaration === null || !deps.persistAccessDeclaration) return;
  await deps.persistAccessDeclaration(input);
}

/**
 * Restore the OLD cached access declaration on a failed UPDATE (cinatra#951)
 * — the finalize seam may have overwritten it with the NEW manifest's
 * declaration; with the OLD install still live, leaving it would feed the W2
 * resolver the failed version's scope truth. Keyed on `isUpdate`, NOT on the
 * prior value being non-null: a legacy row's prior declaration IS null and
 * must be restored to null (the writer supports the explicit clear — codex
 * diff round finding 2). Idempotent same-value rewrite when the finalize-seam
 * write never ran. Best-effort: a failed restore reports through `onFailure`
 * (the caller emits the structured durable-restore event) and never throws.
 */
export async function restorePriorAccessDeclaration(
  deps: Partial<Pick<ConnectorAccessDeclarationInstallDeps, "persistAccessDeclaration">>,
  input: {
    packageName: string;
    orgId: string | null;
    /** The NEW declaration this attempt read (null = not a connector → no-op). */
    accessDeclaration: ResolvedConnectorAccessDeclaration | null;
    isUpdate: boolean;
    /** The captured prior declaration (null restores the explicit clear). */
    prior: ResolvedConnectorAccessDeclaration | null;
  },
  onFailure: (reason: string) => void,
): Promise<void> {
  if (input.accessDeclaration === null || !input.isUpdate || !deps.persistAccessDeclaration) return;
  try {
    await deps.persistAccessDeclaration({
      packageName: input.packageName,
      orgId: input.orgId,
      declaration: input.prior,
    });
  } catch (restoreErr) {
    onFailure(restoreErr instanceof Error ? restoreErr.message : String(restoreErr));
  }
}

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
