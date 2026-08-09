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
import type { ExtensionKind, InstalledExtension } from "./canonical-types";
import { EXTENSION_KINDS } from "./canonical-types";
import { listInstalledExtensions } from "./canonical-store";
import { extensionRegistry } from "./index";
import {
  discoverActiveCapabilities,
  discoverArchivedCapabilities,
  type DiscoveredCapabilities,
} from "./runtime-discovery";

function isExtensionKind(kind: string | undefined): kind is ExtensionKind {
  return kind !== undefined && (EXTENSION_KINDS as readonly string[]).includes(kind);
}

/**
 * OPTIONAL pre-read canonical rows (cinatra#2539).
 *
 * The `installed_extension` table is the SAME input for every reader below, so
 * a caller that renders several of them in one request (the installed-extension
 * catalog reads six) used to issue the identical full-table read once per
 * reader. `rows` lets that caller read the table ONCE and thread the result
 * through; the kind filter is then applied in memory, which is exactly what the
 * SQL `WHERE kind = …` did. Omitting `rows` keeps the original behaviour (each
 * reader does its own read), so every existing call site is unchanged.
 *
 * The rows MUST be an unfiltered snapshot (`listInstalledExtensions()` with no
 * filters). Passing a pre-filtered set would silently narrow every reader that
 * shares it — the loader below is the only caller allowed to build it.
 */
export type CanonicalRowsSnapshot = readonly InstalledExtension[];

async function resolveCanonicalRows(
  kind: ExtensionKind | undefined,
  rows: CanonicalRowsSnapshot | undefined,
): Promise<InstalledExtension[]> {
  if (!rows) return listInstalledExtensions({ kind });
  return kind ? rows.filter((row) => row.kind === kind) : [...rows];
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
  /** Pre-read canonical snapshot — see {@link CanonicalRowsSnapshot}. */
  canonicalRows?: CanonicalRowsSnapshot;
}): Promise<ActiveExtensionManifest[]> {
  // An unknown/invalid kind filter yields nothing rather than an unfiltered scan.
  if (input.kind !== undefined && !isExtensionKind(input.kind)) return [];
  const kind = input.kind as ExtensionKind | undefined;
  const rows = await resolveCanonicalRows(kind, input.canonicalRows);

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
  /** Pre-read canonical snapshot — see {@link CanonicalRowsSnapshot}. */
  canonicalRows?: CanonicalRowsSnapshot;
}): Promise<DiscoveredCapabilities> {
  return discoverActiveCapabilities(
    { kind: input.kind, actor: input.actor, scope: input.scope },
    {
      readActiveManifests: (i) =>
        readActiveManifestsFromStore({ kind: i.kind, canonicalRows: input.canonicalRows }),
      resolveHandler: (k) => extensionRegistry.tryResolve(k),
    },
  );
}

/**
 * Read the lifecycle-ARCHIVED candidate manifests (optionally one kind) —
 * the archived twin of `readActiveManifestsFromStore` (cinatra#948).
 *
 * Same COARSE-gate contract: one manifest per DISTINCT install identity
 * `(kind, packageName, ownerLevel, ownerId, organizationId)` whose row is
 * `archived`, with NO per-actor filtering (visibility is delegated to each
 * kind's `listArchived` reader facet). "Live wins" per identity: an identity
 * that ALSO has an `active`|`locked` row is not archived and is excluded, so
 * a restored/reinstalled package never shows up on the Archived side.
 */
export async function readArchivedManifestsFromStore(input: {
  kind?: string;
  /** Pre-read canonical snapshot — see {@link CanonicalRowsSnapshot}. */
  canonicalRows?: CanonicalRowsSnapshot;
}): Promise<ActiveExtensionManifest[]> {
  if (input.kind !== undefined && !isExtensionKind(input.kind)) return [];
  const kind = input.kind as ExtensionKind | undefined;
  const rows = await resolveCanonicalRows(kind, input.canonicalRows);

  const identityKey = (row: { kind: string; packageName: string; ownerLevel: string; ownerId: string | null; organizationId: string | null }) =>
    `${row.kind}::${row.packageName}::${row.ownerLevel}::${row.ownerId ?? ""}::${row.organizationId ?? ""}`;

  // Identities with any live row — "live wins", never archived.
  const liveIdentities = new Set<string>();
  for (const row of rows) {
    if (row.status === "active" || row.status === "locked") {
      liveIdentities.add(identityKey(row));
    }
  }

  const archived = new Map<string, ActiveExtensionManifest>();
  for (const row of rows) {
    if (row.status !== "archived") continue;
    const key = identityKey(row);
    if (liveIdentities.has(key)) continue;
    if (archived.has(key)) continue;
    archived.set(key, {
      id: row.id,
      packageName: row.packageName,
      kind: row.kind,
      ownerLevel: row.ownerLevel,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
      status: row.status,
    });
  }
  return [...archived.values()];
}

/**
 * The host archived-discovery entry point (cinatra#948) — the archived twin of
 * `discoverActiveExtensionCapabilities`. Reads the archived candidate manifests
 * and dispatches to each kind's `listArchived` reader facet, which applies the
 * resolved visibility `scope`. Kinds without the facet land in
 * `unmigratedKinds` so a management surface can fail loud instead of rendering
 * a deceptively empty archived list.
 */
export async function discoverArchivedExtensionCapabilities(input: {
  kind?: string;
  actor: Actor;
  scope: ExtensionDiscoveryScope;
  /** Pre-read canonical snapshot — see {@link CanonicalRowsSnapshot}. */
  canonicalRows?: CanonicalRowsSnapshot;
}): Promise<DiscoveredCapabilities> {
  return discoverArchivedCapabilities(
    { kind: input.kind, actor: input.actor, scope: input.scope },
    {
      readArchivedManifests: (i) =>
        readArchivedManifestsFromStore({ kind: i.kind, canonicalRows: input.canonicalRows }),
      resolveHandler: (k) => extensionRegistry.tryResolve(k),
    },
  );
}
