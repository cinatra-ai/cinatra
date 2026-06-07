import "server-only";

// Host wiring for the runtime-discovery dispatcher (true-IoC spine).
//
// This binds the pure dispatcher (`runtime-discovery.ts`) to the real
// `installed_extension` canonical store + the live `extensionRegistry`, giving
// the host ONE entry point for dynamic capability discovery that never names a
// specific extension:
//
//   discoverActiveExtensionCapabilities({ kind, actor, scope })
//     -> read lifecycle-live STATUS-CANDIDATE manifests (coarse: which
//        kind+packageName is active|locked — NO per-actor visibility)
//     -> group by kind -> the kind handler's listActive reader facet, which
//        applies the resolved visibility `scope` and is the visibility authority.
//
// Split of authority: `installed_extension` answers only "is
// this package/kind lifecycle-live?"; it can NOT safely answer "may this actor
// see this native row?" without rebuilding the owner-level/membership/vendor
// model — so each per-kind native reader owns visibility for its own rows.

import type {
  Actor,
  ActiveExtensionManifest,
  ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";
import type { ExtensionKind } from "./canonical-types";
import { EXTENSION_KINDS } from "./canonical-types";
import { listInstalledExtensions } from "./canonical-store";
import { extensionRegistry } from "./index";
import { discoverActiveCapabilities, type DiscoveredCapabilities } from "./runtime-discovery";

function isExtensionKind(kind: string | undefined): kind is ExtensionKind {
  return kind !== undefined && (EXTENSION_KINDS as readonly string[]).includes(kind);
}

/**
 * Read the lifecycle-live STATUS-CANDIDATE manifests (optionally one kind).
 *
 * This is a COARSE lifecycle gate, NOT a visibility authority: it returns one
 * manifest per DISTINCT install identity `(kind, packageName, ownerLevel,
 * ownerId, organizationId)` that has at least one `active`|`locked`
 * `installed_extension` row ("live wins"), with NO per-actor/owner filtering.
 * Every owner scope a package is live under is surfaced so the per-kind reader
 * can OR visibility across them (an out-of-scope install must not hide an
 * in-scope one).
 * The `installed_extension` table cannot safely answer "may this actor see this
 * native row?" without rebuilding the whole owner-level/membership/vendor model,
 * so visibility is delegated to each per-kind reader facet (which receives the
 * resolved `ExtensionDiscoveryScope`). Archived/uninstalled-only packages are
 * excluded, so an uninstall is reflected immediately.
 */
export async function readActiveManifestsFromStore(input: {
  kind?: string;
}): Promise<ActiveExtensionManifest[]> {
  // An unknown/invalid kind filter yields nothing rather than an unfiltered scan.
  if (input.kind !== undefined && !isExtensionKind(input.kind)) return [];
  const kind = input.kind as ExtensionKind | undefined;
  const rows = await listInstalledExtensions({ kind });

  // De-dupe by DISTINCT install identity (kind, packageName, ownerLevel,
  // ownerId, organizationId) — NOT just (kind, packageName). Owner-aware reader
  // facets derive a row's visibility from its manifest owner scope, so the gate
  // must surface EVERY owner scope a package is live under; collapsing to one
  // arbitrary owner row would let an out-of-scope install hide an in-scope one
  // (the per-kind reader then ORs visibility across the surviving rows). Within
  // a single identity, prefer 'active' over 'locked' (the stronger signal).
  const livePackages = new Map<string, ActiveExtensionManifest>();
  for (const row of rows) {
    if (row.status !== "active" && row.status !== "locked") continue;
    const key = `${row.kind}::${row.packageName}::${row.ownerLevel}::${row.ownerId ?? ""}::${row.organizationId ?? ""}`;
    const existing = livePackages.get(key);
    // Keep the first row for an identity; only replace a 'locked' with 'active'.
    if (existing && !(existing.status === "locked" && row.status === "active")) {
      continue;
    }
    livePackages.set(key, {
      id: row.id,
      packageName: row.packageName,
      kind: row.kind,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
      status: row.status,
    });
  }
  return [...livePackages.values()];
}

/**
 * The host runtime-discovery entry point. Reads the lifecycle-live candidate
 * manifests and dispatches to each kind's native reader facet, which applies the
 * resolved visibility `scope`. Core code calls this to discover active
 * capabilities WITHOUT importing any named extension.
 *
 * `scope` is resolved by the host (session + Better Auth + vendor config). It is
 * REQUIRED and must fail closed: a public/platform-only scope yields only
 * public/platform-visible capabilities, never "everything active".
 */
export async function discoverActiveExtensionCapabilities(input: {
  kind?: string;
  actor: Actor;
  scope: ExtensionDiscoveryScope;
}): Promise<DiscoveredCapabilities> {
  return discoverActiveCapabilities(
    { kind: input.kind, actor: input.actor, scope: input.scope },
    {
      readActiveManifests: (i) => readActiveManifestsFromStore({ kind: i.kind }),
      resolveHandler: (k) => extensionRegistry.tryResolve(k),
    },
  );
}
