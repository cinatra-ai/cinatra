import "server-only";

// ---------------------------------------------------------------------------
// Installed-extension card rows (cinatra#948) — SHARED row model + loader.
//
// One row per installed extension: kind + lifecycle status + install identity
// come from the canonical `installed_extension` record; display fields (name,
// description, vendor, version) are hydrated from the per-kind native
// descriptors + the registry summary — the canonical record is never the
// display-data source.
//
// Extracted from registry-catalog-screen.tsx so the per-extension Settings
// page (design §V) resolves the SAME display/status/version/vendor as the
// installed card — a single package's header must never disagree with its
// card (displayName vs packageName). Both surfaces call `loadInstalledCardRows`
// and read one shared row; there is no second row-hydration code path.
// ---------------------------------------------------------------------------

import "@/lib/extensions";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { resolveExtensionDiscoveryContext } from "@/lib/extension-discovery-scope";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import {
  manifestVisibleToScope,
  visibleManifestPackageNames,
} from "@cinatra-ai/extension-types";
import type { ExtensionDiscoveryScope } from "@cinatra-ai/extension-types";
import type { AgentTemplateRecord } from "@cinatra-ai/agents";
import { listExtensionPackages } from "@cinatra-ai/registries";
import type { AgentPackageSummary } from "@cinatra-ai/registries";
import {
  discoverActiveExtensionCapabilities,
  discoverArchivedExtensionCapabilities,
  readActiveManifestsFromStore,
  readArchivedManifestsFromStore,
} from "../runtime-discovery-host";
import { listInstalledExtensions } from "../canonical-store";
import type { ExtensionKind, InstalledExtension } from "../canonical-types";
import { sourceVersion } from "../lifecycle-ui";
import { resolveInstalledVendorName } from "./installed-vendor";
// The per-extension Settings route builder lives in the pure model module
// (unit-testable without the server-only loader graph); re-exported here for
// the card + any existing importer.
import { settingsHrefFor } from "./extension-settings-model";
// Card icon source resolver (cinatra#1325) — mirrors /connectors'
// `manifest?.logo ?? null` so the installed card resolves the extension's own
// logo, not the generic kind emblem. Pure module (no server-only graph), so the
// unit test imports it directly.
import { normalizeManifestLogo } from "./installed-card-icon";

export { settingsHrefFor };

export const KIND_LABEL: Record<ExtensionKind, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
  workflow: "Workflow",
};

/** Stable render order: kinds in the platform's canonical order, then name. */
export const KIND_ORDER: ExtensionKind[] = [
  "agent",
  "skill",
  "connector",
  "artifact",
  "workflow",
];

export type InstalledCardRow = {
  kind: ExtensionKind;
  packageName: string;
  displayName: string;
  description: string | null;
  /** Human-readable installed version (already formatted, e.g. with `v`). */
  versionLabel: string | null;
  /** Raw installed semver for update comparison (null when unknowable). */
  rawVersion: string | null;
  vendor: string | null;
  /** Representative canonical row (active > locked > archived precedence). */
  canonical: InstalledExtension | null;
  /** Effective display status. Missing canonical row ⇒ grandfathered active. */
  status: "active" | "locked" | "archived";
  requiredInProd: boolean;
  /**
   * The card's Settings destination — the per-extension Settings page (design
   * §V), one route for every kind. See {@link settingsHrefFor}.
   */
  settingsHref: string;
  visibility: "public" | "private";
  /**
   * The extension's own logo — the sanitized inline-SVG data URI from
   * `cinatra.logo`/`manifest.logo`, or null (cinatra#1325). Resolved from the
   * SAME `STATIC_EXTENSION_MANIFEST` source `/connectors` uses, so the card's
   * icon tile shows the extension's logo (winning over the kind emblem) instead
   * of the generic emblem. Null (absent/blank/malformed) → the card falls back
   * to the kind emblem exactly as before.
   */
  logo: string | null;
};

/** `kind::packageName` — the per-package identity the card list collapses to. */
export function rowKey(kind: string, packageName: string): string {
  return `${kind}::${packageName}`;
}

/**
 * Vendor byline (§VI "{Type} by {Vendor}", cinatra#948 reopen gap 3): the
 * manifest-declared `cinatra.vendor` name, else the registry `author`, else
 * null (the byline drops the "by"). The raw npm scope segment NEVER renders
 * as the vendor.
 */
export function vendorFor(
  summary: AgentPackageSummary | undefined,
  packageName: string,
): string | null {
  return resolveInstalledVendorName({
    manifestVendorName: STATIC_EXTENSION_MANIFEST[packageName]?.vendor?.name ?? null,
    author: summary?.author ?? null,
  });
}

/** Raw installed semver from canonical source provenance (registry installs). */
export function rawInstalledVersion(ext: InstalledExtension | null): string | null {
  if (!ext) return null;
  if (ext.source.type === "verdaccio" || ext.source.type === "bundled") {
    return ext.source.version;
  }
  return null;
}

// Minimal structural shapes of the per-kind native descriptors the reader
// facets return (`DiscoveredCapabilities.byKind` is `unknown[]` by design —
// each kind's native shape belongs to its own package).
type SkillDescriptorLike = {
  packageName?: string | null;
  name?: string;
  description?: string | null;
};
type ConnectorDescriptorLike = {
  packageId: string;
  slug: string;
  displayName: string;
};
type ArtifactDescriptorLike = {
  /** listActive returns object-type defs (`type: "@scope/pkg:slug"`) … */
  type?: string;
  /** … listArchived returns package-level fallback rows. */
  packageName?: string;
};
type WorkflowTemplateLike = {
  packageName?: string | null;
  name?: string;
  description?: string | null;
};

/**
 * Collapse a kind's native descriptors into per-package card rows, hydrating
 * display fields from descriptor + registry summary.
 */
function collapseKindRows(input: {
  kind: ExtensionKind;
  descriptors: unknown[];
  status: "active" | "archived";
  availableByName: Map<string, AgentPackageSummary>;
  canonicalByKey: Map<string, { row: InstalledExtension; requiredInProd: boolean }>;
}): InstalledCardRow[] {
  const { kind, descriptors, availableByName, canonicalByKey } = input;
  const byPackage = new Map<string, InstalledCardRow>();

  for (const descriptor of descriptors) {
    let packageName: string | null = null;
    let nativeName: string | null = null;
    let nativeDescription: string | null = null;
    let nativeVersion: string | null = null;
    let nativeVisibility: "public" | "private" | null = null;

    if (kind === "agent") {
      const t = descriptor as AgentTemplateRecord;
      packageName = t.packageName ?? null;
      nativeName = t.name ?? null;
      nativeDescription = t.description ?? null;
      nativeVersion = t.packageVersion ?? null;
      // The agent native row carries its registry origin — prefer it over the
      // summary (a private agent beyond the registry page cap must not render
      // a "public" badge).
      nativeVisibility = t.origin?.visibility === "private" ? "private" : t.origin ? "public" : null;
    } else if (kind === "skill") {
      const s = descriptor as SkillDescriptorLike;
      packageName = s.packageName ?? null;
      nativeName = s.name ?? null;
      nativeDescription = s.description ?? null;
    } else if (kind === "connector") {
      const c = descriptor as ConnectorDescriptorLike;
      packageName = c.packageId;
      nativeName = c.displayName;
    } else if (kind === "artifact") {
      const a = descriptor as ArtifactDescriptorLike;
      packageName = a.packageName ?? (a.type ? a.type.split(":")[0] : null);
    } else {
      const w = descriptor as WorkflowTemplateLike;
      packageName = w.packageName ?? null;
      nativeName = w.name ?? null;
      nativeDescription = w.description ?? null;
    }
    if (!packageName) continue;

    const existing = byPackage.get(packageName);
    if (existing) {
      // Multiple native descriptors for one package (an agent pack's templates,
      // a skill pack's skills, an artifact pack's object types) collapse to ONE
      // card; a multi-descriptor package falls back to the registry title so
      // the card is not mislabeled with an arbitrary member's name.
      const summary = availableByName.get(packageName);
      if (summary?.title) existing.displayName = summary.title;
      continue;
    }

    const summary = availableByName.get(packageName);
    const canonical = canonicalByKey.get(rowKey(kind, packageName)) ?? null;
    const canonicalRow = canonical?.row ?? null;
    const status: InstalledCardRow["status"] =
      input.status === "archived"
        ? "archived"
        : canonicalRow?.status === "locked"
          ? "locked"
          : "active";
    const rawVersion = nativeVersion ?? rawInstalledVersion(canonicalRow);
    const versionLabel = nativeVersion
      ? `v${nativeVersion}`
      : canonicalRow
        ? sourceVersion(canonicalRow)
        : summary?.packageVersion
          ? `v${summary.packageVersion}`
          : null;

    const settingsHref = settingsHrefFor(kind, packageName);

    const origin = summary?.origin ?? null;
    byPackage.set(packageName, {
      kind,
      packageName,
      displayName: nativeName ?? summary?.title ?? packageName,
      description: nativeDescription ?? summary?.description ?? null,
      versionLabel,
      rawVersion,
      vendor: vendorFor(summary, packageName),
      canonical: canonicalRow,
      status,
      requiredInProd: canonical?.requiredInProd ?? false,
      settingsHref,
      visibility:
        nativeVisibility ?? (origin?.visibility === "private" ? "private" : "public"),
      logo: normalizeManifestLogo(STATIC_EXTENSION_MANIFEST[packageName]?.logo),
    });
  }

  return [...byPackage.values()];
}

/**
 * Runtime-only connectors (no build-time catalog descriptor — e.g. a
 * runtime-installed schema-config connector) are invisible to the connector
 * reader facet, which lists the build-time catalog. Union them in from the
 * canonical gate under the SAME owner-scope visibility the connector facet
 * applies (the catalog carries no per-owner visibility of its own, so this is
 * visibility-equivalent, not a bypass).
 */
function runtimeOnlyConnectorRows(input: {
  manifests: Awaited<ReturnType<typeof readActiveManifestsFromStore>>;
  status: "active" | "archived";
  catalogPackageIds: Set<string>;
  scope: ExtensionDiscoveryScope;
  availableByName: Map<string, AgentPackageSummary>;
  canonicalByKey: Map<string, { row: InstalledExtension; requiredInProd: boolean }>;
}): InstalledCardRow[] {
  const runtimeOnly = input.manifests.filter(
    (m) => m.kind === "connector" && !input.catalogPackageIds.has(m.packageName),
  );
  if (runtimeOnly.length === 0) return [];
  const visible = visibleManifestPackageNames(runtimeOnly, input.scope);

  const rows: InstalledCardRow[] = [];
  for (const packageName of visible) {
    const summary = input.availableByName.get(packageName);
    const canonical = input.canonicalByKey.get(rowKey("connector", packageName)) ?? null;
    const canonicalRow = canonical?.row ?? null;
    const scopedMatch = /^@([^/]+)\/(.+)$/.exec(packageName);
    rows.push({
      kind: "connector",
      packageName,
      displayName: summary?.title ?? (scopedMatch ? scopedMatch[2] : packageName),
      description: summary?.description ?? null,
      versionLabel: canonicalRow ? sourceVersion(canonicalRow) : null,
      rawVersion: rawInstalledVersion(canonicalRow),
      vendor: vendorFor(summary, packageName),
      canonical: canonicalRow,
      status:
        input.status === "archived"
          ? "archived"
          : canonicalRow?.status === "locked"
            ? "locked"
            : "active",
      requiredInProd: canonical?.requiredInProd ?? false,
      settingsHref: settingsHrefFor("connector", packageName),
      visibility: summary?.origin?.visibility === "private" ? "private" : "public",
      logo: normalizeManifestLogo(STATIC_EXTENSION_MANIFEST[packageName]?.logo),
    });
  }
  return rows;
}

function sortRows(rows: InstalledCardRow[]): InstalledCardRow[] {
  return rows.sort((a, b) => {
    const kindDelta = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (kindDelta !== 0) return kindDelta;
    return a.displayName.localeCompare(b.displayName);
  });
}

export type LoadedInstalledCardRows = {
  active: InstalledCardRow[];
  archived: InstalledCardRow[];
  /** Registry catalog entries by packageName (newest published version, author). */
  availableByName: Map<string, AgentPackageSummary>;
  /** Resolved per-actor discovery scope (the caller reuses `organizationId`). */
  scope: ExtensionDiscoveryScope;
};

/**
 * Load and build the installed-extension rows (active + archived) for the
 * actor's session. The single source of truth for the installed card list AND
 * the per-extension Settings page — both must resolve the same row for a given
 * (kind, packageName), so neither surface re-hydrates display data on its own.
 */
export async function loadInstalledCardRows(
  session: Parameters<typeof resolveExtensionDiscoveryContext>[0],
  opts: { query?: string } = {},
): Promise<LoadedInstalledCardRows> {
  // Resolve VerdaccioConfig once and thread it through registry calls. Without
  // explicit config, ensureConfig inside listExtensionPackages fail-fast throws.
  const verdaccioConfig = await loadVerdaccioConfigForReads();

  // Resolve vendorScope for the visibility filter from approved-vendor state
  // (or legacy publish-token presence), not from the freely-editable
  // instanceNamespace, so an unapproved consumer can't impersonate a vendor.
  const identity = readInstanceIdentity();
  const vendorScope = getEffectiveViewerScope(identity);

  // Resolve the per-actor discovery context once (session → actor + visibility
  // scope). Each per-kind reader facet applies this resolved scope.
  const { actor, scope } = await resolveExtensionDiscoveryContext(
    session,
    vendorScope ?? null,
  );

  // Warm the object-type registry so the artifact reader facet sees the
  // bundled artifact types even when this page is the first surface rendered
  // by a fresh server process.
  registerAllObjectTypes();

  const [
    available,
    discoveredActive,
    discoveredArchived,
    activeManifests,
    archivedManifests,
    canonicalRows,
  ] = await Promise.all([
    // Kind-authoritative registry page (packument-level metadata for ALL
    // kinds) — the display hydration + update-detection source.
    listExtensionPackages(
      { query: opts.query, limit: 200, viewerScope: vendorScope },
      verdaccioConfig,
    ),
    // Active = canonical dispatcher across ALL kinds: installed_extension
    // (active|locked) gate ∩ each kind's visibility reader facet.
    discoverActiveExtensionCapabilities({ actor, scope }),
    // Archived twin: archived candidate manifests ∩ each kind's listArchived
    // reader facet — the same actor-scoped per-kind visibility.
    discoverArchivedExtensionCapabilities({ actor, scope }),
    // Coarse manifest reads for the runtime-only-connector union below (the
    // union re-applies the shared owner-scope gate before rendering).
    readActiveManifestsFromStore({ kind: "connector" }),
    readArchivedManifestsFromStore({ kind: "connector" }),
    // Canonical rows ANNOTATE the discovered (already visibility-filtered)
    // rows with lifecycle status / requiredInProd / installed version.
    listInstalledExtensions(),
  ]);

  // Fail loud, never silent: an unmigrated kind means live/archived manifests
  // exist for it but no reader facet resolved — i.e. the `@/lib/extensions`
  // handler registration did not run in this runtime.
  for (const [label, discovered] of [
    ["active", discoveredActive],
    ["archived", discoveredArchived],
  ] as const) {
    if (discovered.unmigratedKinds.length > 0) {
      console.error(
        `[installed-rows] runtime discovery returned UNMIGRATED kinds for the ${label} ` +
          `list: ${discovered.unmigratedKinds.join(", ")}. Those kinds' rows are missing. ` +
          "Verify the `@/lib/extensions` side-effect import ran.",
      );
    }
  }

  // Registry catalog entries by packageName: display hydration + the
  // update-available comparison.
  const availableByName = new Map(available.map((entry) => [entry.packageName, entry]));

  // Canonical annotation map keyed kind::packageName, built ONLY from rows
  // whose install identity is visible to the actor's resolved scope. Within
  // the actor-visible identities: locked > active > archived (if ANY visible
  // identity is locked, the card carries the locked indicator). requiredInProd
  // ORs across the visible identities.
  const STATUS_RANK: Record<string, number> = { locked: 0, active: 1, archived: 2 };
  const canonicalByKey = new Map<string, { row: InstalledExtension; requiredInProd: boolean }>();
  for (const row of canonicalRows) {
    if (!manifestVisibleToScope(row, scope)) continue;
    const key = rowKey(row.kind, row.packageName);
    const existing = canonicalByKey.get(key);
    if (!existing) {
      canonicalByKey.set(key, { row, requiredInProd: row.requiredInProd });
      continue;
    }
    existing.requiredInProd = existing.requiredInProd || row.requiredInProd;
    if (STATUS_RANK[row.status] < STATUS_RANK[existing.row.status]) {
      existing.row = row;
    }
  }

  // Build-time connector catalog ids (for the runtime-only union).
  const catalogConnectorIds = new Set(
    ((discoveredActive.byKind.connector ?? []) as ConnectorDescriptorLike[])
      .concat((discoveredArchived.byKind.connector ?? []) as ConnectorDescriptorLike[])
      .map((c) => c.packageId),
  );

  const active = sortRows([
    ...KIND_ORDER.flatMap((kind) =>
      collapseKindRows({
        kind,
        descriptors: discoveredActive.byKind[kind] ?? [],
        status: "active",
        availableByName,
        canonicalByKey,
      }),
    ),
    ...runtimeOnlyConnectorRows({
      manifests: activeManifests,
      status: "active",
      catalogPackageIds: catalogConnectorIds,
      scope,
      availableByName,
      canonicalByKey,
    }),
  ]);

  // NOTE deliberately NOT filtered against the active rows: "live wins" is a
  // per-IDENTITY rule (readArchivedManifestsFromStore already excludes any
  // identity that also has a live row). A package live under ONE visible
  // identity while ARCHIVED under another must still surface here, or the
  // archived install's Restore becomes unreachable.
  const archived = sortRows([
    ...KIND_ORDER.flatMap((kind) =>
      collapseKindRows({
        kind,
        descriptors: discoveredArchived.byKind[kind] ?? [],
        status: "archived",
        availableByName,
        canonicalByKey,
      }),
    ),
    ...runtimeOnlyConnectorRows({
      manifests: archivedManifests,
      status: "archived",
      catalogPackageIds: catalogConnectorIds,
      scope,
      availableByName,
      canonicalByKey,
    }),
  ]);

  return { active, archived, availableByName, scope };
}
