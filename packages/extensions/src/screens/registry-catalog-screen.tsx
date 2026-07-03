import { Archive, Package, Settings, Upload } from "lucide-react";
import { VisibilityBadge } from "@/components/visibility-badge";
import { ExtensionRowActions } from "./extension-row-actions";
import Link from "next/link";
import {
  requireAuthSession,
  buildCanDoOptsFromSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";
import { canDo } from "@/lib/authz";
// Side-effect import: registers the per-kind ExtensionTypeHandlers into
// extensionRegistry so the runtime-discovery dispatcher can resolve them in
// this RSC path. Mirrors src/lib/mcp-server.ts. Without it the dispatcher
// would find no handlers and both tabs would be empty.
import "@/lib/extensions";
// The artifact reader facet lists the in-memory object-type registry, which is
// populated LAZILY (artifact-service surfaces + the dev watcher) — on a fresh
// production server this page can render before anything warmed it, silently
// dropping every artifact card. Warm it exactly like the artifact services do
// (idempotent; replace-by-id registry).
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { resolveExtensionDiscoveryContext } from "@/lib/extension-discovery-scope";
import { getConnectorSetupHref } from "@/lib/connectors-registry.server";
// Active + archived discovery both route through the canonical
// runtime-discovery dispatchers (installed_extension gate ∩ each kind's
// visibility reader facet). cinatra#948: the page lists ALL kinds via the
// actor-scoped read-model — the agent-only carve-outs are gone.
import {
  discoverActiveExtensionCapabilities,
  discoverArchivedExtensionCapabilities,
  readActiveManifestsFromStore,
  readArchivedManifestsFromStore,
} from "../runtime-discovery-host";
import { listInstalledExtensions } from "../canonical-store";
import type { ExtensionKind, InstalledExtension } from "../canonical-types";
import { lifecycleBadgesFor, sourceVersion } from "../lifecycle-ui";
import {
  manifestVisibleToScope,
  visibleManifestPackageNames,
} from "@cinatra-ai/extension-types";
import type { ExtensionDiscoveryScope } from "@cinatra-ai/extension-types";
import type { AgentTemplateRecord } from "@cinatra-ai/agents";
import {
  updateExtensionPackageFormAction,
  uninstallExtensionPackageFormAction,
  restoreExtensionPackageFormAction,
  reinstallLatestFormAction,
} from "../actions";
import {
  comparePluginVersions,
  getPublishedExtensionSummary,
  listExtensionPackages,
} from "@cinatra-ai/registries";
import type { AgentPackageSummary } from "@cinatra-ai/registries";
import { resolveRiskLevelsByPackageName } from "./registry-risk";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { extensionHasBeenUsedBatch } from "@cinatra-ai/extensions";
import { RegistryUninstallForm } from "./registry-uninstall-form";
import type { DestinationVariant } from "./registry-uninstall-form";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { RiskBadge } from "@/components/risk-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
} from "@/components/ui/toolbar";
import { ExtensionsTabSelect } from "@/components/extensions/extensions-tab-select";
import { InstallBatchPanel } from "@/components/extensions/install-batch-panel";
import { InstallBatchLiveRefresh } from "@/components/extensions/install-batch-live-refresh";
import { InstalledExtensionCard } from "@/components/extensions/installed-extension-card";
import {
  extensionKindEmblem,
  type ExtensionEmblemKind,
} from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { hasActiveInstallBatch } from "@/lib/extension-dependency-ux";
import { listRecentInstallBatches } from "@/lib/extension-install-batch-ops";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

// ---------------------------------------------------------------------------
// Empty state sub-components
// ---------------------------------------------------------------------------

function ActiveEmptyState() {
  return (
    <div className="soft-panel rounded-card flex flex-col items-center justify-center py-16 text-center gap-3">
      <Package className="h-8 w-8 text-muted-foreground" />
      <p className="font-semibold text-foreground">No active extensions</p>
      <p className="text-sm text-muted-foreground">
        No extensions are installed yet. Browse the marketplace to add one.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/configuration/marketplace">Browse marketplace</Link>
      </Button>
    </div>
  );
}

function ArchivedEmptyState() {
  return (
    <div className="soft-panel rounded-card flex flex-col items-center justify-center py-16 text-center gap-3">
      <Archive className="h-8 w-8 text-muted-foreground" />
      <p className="font-semibold text-foreground">No archived extensions</p>
      <p className="text-sm text-muted-foreground">
        Extensions uninstalled after first use appear here. Their run history
        remains intact.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card row model (cinatra#948)
//
// One card per installed extension: kind + lifecycle status + install identity
// come from the canonical `installed_extension` record; display fields (name,
// description, vendor, version) are hydrated from the per-kind native
// descriptors + the registry summary — the canonical record is never the
// display-data source.
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ExtensionKind, string> = {
  agent: "Agent",
  skill: "Skill",
  connector: "Connector",
  artifact: "Artifact",
  workflow: "Workflow",
};

/** Stable render order: kinds in the platform's canonical order, then name. */
const KIND_ORDER: ExtensionKind[] = ["agent", "skill", "connector", "artifact", "workflow"];

type InstalledCardRow = {
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
  /** Per-extension configuration surface (connectors only today). */
  settingsHref: string | null;
  detailHref: string | null;
  visibility: "public" | "private";
};

/** `kind::packageName` — the per-package identity the card list collapses to. */
function rowKey(kind: string, packageName: string): string {
  return `${kind}::${packageName}`;
}

function detailHrefFor(packageName: string): string | null {
  const scopedMatch = /^@([^/]+)\/(.+)$/.exec(packageName);
  return scopedMatch
    ? `/configuration/marketplace/${scopedMatch[1]}/${scopedMatch[2]}`
    : null;
}

/** Vendor byline: registry `author`, else the npm scope segment. */
function vendorFor(summary: AgentPackageSummary | undefined, packageName: string): string | null {
  if (summary?.author) return summary.author;
  const scopedMatch = /^@([^/]+)\//.exec(packageName);
  return scopedMatch ? scopedMatch[1] : null;
}

/** Raw installed semver from canonical source provenance (registry installs). */
function rawInstalledVersion(ext: InstalledExtension | null): string | null {
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

    let settingsHref: string | null = null;
    if (kind === "connector") {
      const c = descriptor as ConnectorDescriptorLike;
      settingsHref = c.slug ? getConnectorSetupHref(c.slug) : null;
    }

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
      detailHref: detailHrefFor(packageName),
      visibility:
        nativeVisibility ?? (origin?.visibility === "private" ? "private" : "public"),
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
      // The connector dispatch route resolves runtime-only connectors at
      // /connectors/<vendor>/<slug>/<subroute> with the standard setup
      // subroute (see src/app/connectors/[vendor]/[slug]/[subroute]).
      settingsHref: scopedMatch
        ? `/connectors/${scopedMatch[1]}/${scopedMatch[2]}/setup`
        : null,
      detailHref: detailHrefFor(packageName),
      visibility: summary?.origin?.visibility === "private" ? "private" : "public",
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

// ---------------------------------------------------------------------------
// RegistryCatalogScreen
// ---------------------------------------------------------------------------

export async function RegistryCatalogScreen({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuthSession();
  // Compute the admin flag once so ExtensionRowActions (Promote/Demote) is
  // only rendered for admins. Non-admin clicks would bounce off requireAdminSession()
  // in the action, but hiding the menu avoids the confusing UX.
  const isAdmin = isPlatformAdmin(session);
  // Compute role-aware booleans once per render so the per-card button matrix
  // matches the server-action gate (defense-in-depth).
  const opts = await buildCanDoOptsFromSession(session);
  const canUpdate = canDo(session, "registry.update", undefined, opts);
  const canUninstall = canDo(session, "registry.uninstall", undefined, opts);

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  // URL-driven tab selection. Server-side narrowing: only "archived" is
  // accepted; any other value falls through to "active".
  const tab = resolvedSearchParams?.tab === "archived" ? "archived" : "active";
  const queryValue = resolvedSearchParams?.q;
  const query =
    typeof queryValue === "string"
      ? queryValue
      : Array.isArray(queryValue)
        ? queryValue[0]
        : undefined;

  // Resolve VerdaccioConfig once at the screen boundary and thread it through
  // registry calls. Without explicit config, ensureConfig inside
  // listExtensionPackages fail-fast throws.
  const verdaccioConfig = await loadVerdaccioConfigForReads();

  // Resolve vendorScope at the screen boundary for the visibility filter.
  // Use the canonical helper — derives the scope from approved-vendor state
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
  // by a fresh server process (see the import note above).
  registerAllObjectTypes();

  const [
    available,
    discoveredActive,
    discoveredArchived,
    activeManifests,
    archivedManifests,
    canonicalRows,
    recentBatches,
  ] = await Promise.all([
    // Kind-authoritative registry page (packument-level metadata for ALL
    // kinds; listAgentPackages would drop non-agent packages) — the display
    // hydration + update-detection source.
    listExtensionPackages({ query, limit: 200, viewerScope: vendorScope }, verdaccioConfig),
    // Active = canonical dispatcher across ALL kinds: installed_extension
    // (active|locked) gate ∩ each kind's visibility reader facet. A published
    // package with no live manifest (never-installed) is correctly excluded.
    discoverActiveExtensionCapabilities({ actor, scope }),
    // Archived twin (cinatra#948): archived candidate manifests ∩ each kind's
    // listArchived reader facet — the same actor-scoped per-kind visibility as
    // the active side, replacing the old agent-only archived carve-out.
    discoverArchivedExtensionCapabilities({ actor, scope }),
    // Coarse manifest reads for the runtime-only-connector union below (the
    // union re-applies the shared owner-scope gate before rendering).
    readActiveManifestsFromStore({ kind: "connector" }),
    readArchivedManifestsFromStore({ kind: "connector" }),
    // Canonical rows ANNOTATE the discovered (already visibility-filtered)
    // rows with lifecycle status / requiredInProd / installed version. This is
    // not a listing source — discovery above owns visibility.
    listInstalledExtensions(),
    // Recent dependency-install batches (cinatra #209 item 2, surfaces 2 & 3):
    // the durable `extension_install_batches` ledger drives the per-member
    // install progress + the batch compensation outcomes. READ-ONLY.
    //
    // ORG-SCOPED (security): pass the actor's active org so this read returns
    // ONLY the current organization's batches — never another tenant's. The
    // ops layer filters NULL-safe (`org_id IS NOT DISTINCT FROM $1`), so a
    // member with no active org (`null`) correctly sees only platform-scoped
    // batches. NOTE: we deliberately do NOT read cross-org here even for a
    // platform_admin; a genuine cross-tenant operator view must be a separate,
    // explicitly isAdmin-gated surface, not the default per-member screen.
    // Best-effort: a ledger read failure must never blank the Extensions list,
    // so it degrades to "no recent installs" with a logged warning.
    listRecentInstallBatches({ limit: 10, orgId: scope.organizationId }).catch((err: unknown) => {
      console.warn(
        "[registry-catalog] could not read recent install batches (panel omitted):",
        err instanceof Error ? err.message : err,
      );
      return [] as Awaited<ReturnType<typeof listRecentInstallBatches>>;
    }),
  ]);

  // Fail loud, never silent: an unmigrated kind means live/archived manifests
  // exist for it but no reader facet resolved — i.e. the `@/lib/extensions`
  // handler registration did not run in this runtime (or hit a different
  // module instance). Without this a registration regression would render as
  // a deceptively empty list ("nothing installed").
  for (const [label, discovered] of [
    ["active", discoveredActive],
    ["archived", discoveredArchived],
  ] as const) {
    if (discovered.unmigratedKinds.length > 0) {
      console.error(
        `[registry-catalog] runtime discovery returned UNMIGRATED kinds for the ${label} ` +
          `list: ${discovered.unmigratedKinds.join(", ")}. Those kinds' rows are missing. ` +
          "Verify the `@/lib/extensions` side-effect import ran.",
      );
    }
  }

  // Registry catalog entries by packageName: display hydration + the
  // update-available comparison.
  const availableByName = new Map(available.map((entry) => [entry.packageName, entry]));

  // Canonical annotation map keyed kind::packageName, built ONLY from rows
  // whose install identity is visible to the actor's resolved scope (the same
  // shared owner-scope gate the reader facets apply) — an out-of-scope
  // identity's lifecycle/version/lock metadata must never annotate (or leak
  // onto) a card another tenant renders. Representative-row precedence within
  // the actor-visible identities: locked > active > archived — conservative:
  // if ANY visible identity is locked, the card carries the locked indicator
  // and suppresses the predictably-rejected destructive affordances.
  // requiredInProd ORs across the visible identities.
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

  const activeRows = sortRows([
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
  // identity (say the platform's) while ARCHIVED under another (the actor's
  // org) must still surface here, or the archived install's Restore becomes
  // unreachable. Same-identity duplicates cannot occur.
  const archivedRows = sortRows([
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

  // Single batch SQL query replaces N per-row extensionHasBeenUsed calls —
  // drives the uninstall dialog's archive-vs-remove destination copy.
  const usedExtensions = await extensionHasBeenUsedBatch(
    activeRows.map((r) => r.packageName),
  );

  // Risk data for BOTH tabs. Fast path: the `available` registry page
  // (riskLevel rides on every summary). Backfill: names that page missed
  // (q filter / row cap / viewer scope) resolve through a packument-only
  // read. Rows absent from the map render no risk badge — see
  // registry-risk.ts for the full contract.
  const riskLevelByPackageName = await resolveRiskLevelsByPackageName({
    summaries: available,
    packageNames: [...activeRows, ...archivedRows].map((r) => r.packageName),
    readPublishedSummary: (packageName) =>
      getPublishedExtensionSummary({ packageName }, verdaccioConfig),
  });

  // -------------------------------------------------------------------------
  // Card renderers
  // -------------------------------------------------------------------------

  const renderStatus = (row: InstalledCardRow) => {
    const badges = row.canonical
      ? lifecycleBadgesFor(row.canonical).filter(
          (b) => b.key === "locked" || b.key === "required",
        )
      : [];
    const riskLevel = riskLevelByPackageName.get(row.packageName);
    return (
      <>
        <LifecycleBadge status={row.status === "archived" ? "archived" : "active"} />
        {badges.map((b) => (
          <Badge key={b.key} variant={b.variant} title={b.title}>
            {b.label}
          </Badge>
        ))}
        <VisibilityBadge visibility={row.visibility} />
        {riskLevel && <RiskBadge riskLevel={riskLevel} />}
      </>
    );
  };

  const renderActiveActions = (row: InstalledCardRow) => {
    // Locked / required-in-prod extensions cannot be uninstalled or updated
    // from this surface (the dispatcher rejects the transition) — suppress the
    // predictably-failing affordances instead of rendering them.
    const locked = row.status === "locked" || row.requiredInProd;
    const registryEntry = availableByName.get(row.packageName);
    const updateState = comparePluginVersions(
      row.rawVersion ?? undefined,
      registryEntry?.packageVersion ?? row.rawVersion ?? "",
    );
    const hasUpdate = updateState === "update-available";
    const destinationVariant: DestinationVariant = usedExtensions.has(row.packageName)
      ? "archive"
      : "remove";
    const uninstallAction = uninstallExtensionPackageFormAction.bind(null, {
      packageName: row.packageName,
      packageVersion: row.rawVersion ?? "",
    }) as unknown as (formData?: FormData) => void | Promise<void>;

    return (
      <>
        {row.settingsHref && (
          <Button asChild size="sm">
            <Link href={row.settingsHref}>
              <Settings data-icon="inline-start" />
              Settings
            </Link>
          </Button>
        )}
        {row.detailHref && (
          <Button asChild variant="ghost" size="sm">
            <Link href={row.detailHref}>More details</Link>
          </Button>
        )}
        {hasUpdate && canUpdate && !locked && (
          <form
            action={async () => {
              "use server";
              // Plain server-action form (no toast surface on this management
              // screen): discard the #685 classified-failure return so the
              // action stays () => void. Success still redirect()s as before.
              await updateExtensionPackageFormAction({
                packageName: row.packageName,
                packageVersion: registryEntry?.packageVersion ?? row.rawVersion ?? "",
              });
            }}
          >
            <Button type="submit" variant="outline" size="sm" className="w-full">
              Update
            </Button>
          </form>
        )}
        {canUninstall && !locked && (
          <RegistryUninstallForm
            action={uninstallAction}
            packageTitle={row.displayName}
            destinationVariant={destinationVariant}
            variant="outline"
            size="sm"
            className="w-full hover:text-destructive"
          />
        )}
        {/* Overflow menu with Promote / Demote actions. Only rendered for
            admins, and ONLY for agent rows — promote/demote resolves
            agent-template origin data, so it stays scoped to the kind it
            supported on the old table (other kinds would get a
            predictably-broken action). */}
        {isAdmin && row.kind === "agent" && (
          <ExtensionRowActions
            packageName={row.packageName}
            packageVersion={row.rawVersion ?? ""}
            visibility={row.visibility}
          />
        )}
      </>
    );
  };

  const renderArchivedActions = (row: InstalledCardRow) => (
    <>
      {row.detailHref && (
        <Button asChild variant="ghost" size="sm">
          <Link href={row.detailHref}>More details</Link>
        </Button>
      )}
      <form
        action={async () => {
          "use server";
          // Discard the #685 classified-failure return so the action stays
          // () => void on this plain-form management screen.
          await restoreExtensionPackageFormAction({
            packageName: row.packageName,
          });
        }}
      >
        <Button type="submit" variant="outline" size="sm" className="w-full">
          {row.rawVersion ? `Restore (${row.rawVersion} pinned)` : "Restore"}
        </Button>
      </form>
      <form action={reinstallLatestFormAction.bind(null, { packageName: row.packageName })}>
        <Button type="submit" variant="outline" size="sm" className="w-full">
          Reinstall latest
        </Button>
      </form>
    </>
  );

  const renderCard = (row: InstalledCardRow, isArchived: boolean) => (
    <InstalledExtensionCard
      key={rowKey(row.kind, row.packageName)}
      name={row.displayName}
      accentColor={deriveExtensionAccent(row.packageName)}
      emblem={extensionKindEmblem(row.kind as ExtensionEmblemKind)}
      kindIcon={extensionKindEmblem(row.kind as ExtensionEmblemKind, "size-3.5")}
      kindLabel={KIND_LABEL[row.kind]}
      vendor={row.vendor}
      description={row.description}
      version={row.versionLabel}
      status={renderStatus(row)}
      actions={isArchived ? renderArchivedActions(row) : renderActiveActions(row)}
    />
  );

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Extensions"
        description="Manage installed agents, skills, connectors, and artifacts."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Toolbar layout per the design system's Installed-extensions
            section: the Active/Archived status filter on the left;
            "Marketplace" + "Upload" on the right. */}
        <Toolbar aria-label="Extensions filters">
          <ToolbarGroup>
            <ExtensionsTabSelect value={tab} />
          </ToolbarGroup>
          <div aria-hidden className="flex-1" />
          <ToolbarGroup>
            <ToolbarButton asChild>
              <Link href="/configuration/marketplace">
                <Package data-icon="inline-start" />
                Marketplace
              </Link>
            </ToolbarButton>
            <ToolbarButton asChild>
              <Link href="/configuration/extensions/upload">
                <Upload data-icon="inline-start" />
                Upload
              </Link>
            </ToolbarButton>
          </ToolbarGroup>
        </Toolbar>

        {tab === "active" ? (
          <div className="flex flex-col gap-6">
            {/* Recent dependency-install batches: per-member progress +
                compensation outcomes from the durable ledger (cinatra #209
                item 2, surfaces 2 & 3). Renders nothing when there are no
                batches. While any batch is non-terminal, poll
                router.refresh() so the server snapshot below stays live
                (cinatra #851 finding 3). */}
            <InstallBatchLiveRefresh active={hasActiveInstallBatch(recentBatches)} />
            <InstallBatchPanel batches={recentBatches} />
            {activeRows.length === 0 ? (
              <ActiveEmptyState />
            ) : (
              <div className="grid gap-3">{activeRows.map((row) => renderCard(row, false))}</div>
            )}
          </div>
        ) : (
          <div>
            {archivedRows.length === 0 ? (
              <ArchivedEmptyState />
            ) : (
              <div className="grid gap-3">{archivedRows.map((row) => renderCard(row, true))}</div>
            )}
          </div>
        )}
      </PageContent>
    </Main>
  );
}
