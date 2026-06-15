import { Archive, Package, Upload } from "lucide-react";
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
// Side-effect import: registers the per-kind ExtensionTypeHandlers (incl. the
// agent reader facet) into extensionRegistry so the runtime-discovery dispatcher
// can resolve them in this RSC path. Mirrors src/lib/mcp-server.ts. Without it
// the dispatcher would find no agent handler and the Active tab would be empty.
import "@/lib/extensions";
import { resolveExtensionDiscoveryContext } from "@/lib/extension-discovery-scope";
// Active discovery routes through the canonical runtime-discovery dispatcher
// (installed_extension gate ∩ the agent kind's visibility reader). Archived
// inventory is lifecycle management, NOT active-capability discovery, so it
// keeps reading the agent native store directly — an intentional carve-out.
import { discoverActiveExtensionCapabilities } from "../runtime-discovery-host";
import { readArchivedExtensionTemplates } from "@cinatra-ai/agents";
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
  listAgentPackages,
} from "@cinatra-ai/registries";
import { resolveRiskLevelsByPackageName } from "./registry-risk";
import { loadVerdaccioConfigForReads } from "@/lib/verdaccio-config";
import { extensionHasBeenUsedBatch } from "@cinatra-ai/extensions";
import { RegistryUninstallForm } from "./registry-uninstall-form";
import type { DestinationVariant } from "./registry-uninstall-form";
import { LifecycleBadge } from "@/components/lifecycle-badge";
import { RiskBadge } from "@/components/risk-badge";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Button } from "@/components/ui/button";
import {
  Toolbar,
  ToolbarButton,
  ToolbarGroup,
  ToolbarSeparator,
} from "@/components/ui/toolbar";
import { ExtensionsTabSelect } from "@/components/extensions/extensions-tab-select";
import { InstallBatchPanel } from "@/components/extensions/install-batch-panel";
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
  // Compute role-aware booleans once per render so the per-row button matrix
  // matches the server-action gate (defense-in-depth).
  const opts = await buildCanDoOptsFromSession(session);
  const canUpdate = canDo(session, "registry.update", undefined, opts);
  // Catalog rows expose Uninstall in a secondary actions dropdown for installed
  // packages, matching the detail page.
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
  // listAgentPackages fail-fast throws.
  const verdaccioConfig = await loadVerdaccioConfigForReads();

  // Resolve vendorScope at the screen boundary for the visibility filter.
  // Use the canonical helper — derives the scope from approved-vendor state
  // (or legacy publish-token presence), not from the freely-editable
  // instanceNamespace, so an unapproved consumer can't impersonate a vendor.
  const identity = readInstanceIdentity();
  const vendorScope = getEffectiveViewerScope(identity);

  // Resolve the per-actor discovery context once (session → actor + visibility
  // scope). The agent reader keys on scope.vendorScope today; the full scope is
  // resolved so future per-kind readers (org/team-visible rows) are correct.
  const { actor, scope } = await resolveExtensionDiscoveryContext(
    session,
    vendorScope ?? null,
  );

  const [available, discovered, archivedTemplates, recentBatches] = await Promise.all([
    listAgentPackages({ query, limit: 200, viewerScope: vendorScope }, verdaccioConfig),
    // Active = canonical dispatcher: installed_extension (active|locked) gate ∩
    // the agent kind's visibility reader. A published template with no live
    // manifest (never-installed) is correctly excluded — it is not "active".
    discoverActiveExtensionCapabilities({ kind: "agent", actor, scope }),
    readArchivedExtensionTemplates(vendorScope),
    // Recent dependency-install batches (cinatra #209 item 2, surfaces 2 & 3):
    // the durable `extension_install_batches` ledger drives the per-member
    // install progress + the batch compensation outcomes. READ-ONLY; a depless
    // single-package install never wrote a ledger row, so this is empty for an
    // instance that only installed extensions without dependencies.
    //
    // ORG-SCOPED (security): pass the actor's active org so this read returns
    // ONLY the current organization's batches — never another tenant's. The
    // screen is gated by requireAuthSession() alone (isAdmin only gates the
    // Promote/Demote row actions), so an unscoped read would expose org B's
    // root+dependency package names and per-member progress/compensation detail
    // to any authenticated member of org A. `scope.organizationId` is the SAME
    // active-org id the sibling `discoverActiveExtensionCapabilities({ scope })`
    // read uses and the value the saga persists to `org_id` (saga:
    // `input.actor.orgId ?? null`), so the read matches what was written. The
    // ops layer filters NULL-safe (`org_id IS NOT DISTINCT FROM $1`), so a
    // member with no active org (`null`) correctly sees only platform-scoped
    // batches — mirroring the saga's own `(b.orgId ?? null) !== orgId` scoping.
    // NOTE: we deliberately do NOT read cross-org here even for a platform_admin;
    // a genuine cross-tenant operator view must be a separate, explicitly
    // isAdmin-gated surface, not the default per-member screen.
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
  const activeTemplates = (discovered.byKind.agent ?? []) as AgentTemplateRecord[];
  // Fail loud, never silent: `unmigratedKinds` contains "agent" only when the
  // gate reported live agent manifests but no agent reader facet resolved — i.e.
  // the `@/lib/extensions` handler registration did not run in this runtime (or
  // hit a different module instance). Without this a registration regression
  // would render as a deceptively empty Active tab ("nothing installed").
  if (discovered.unmigratedKinds.includes("agent")) {
    console.error(
      "[registry-catalog] runtime discovery returned the agent kind as UNMIGRATED — " +
        "the agent ExtensionTypeHandler is not registered in this runtime. The Active " +
        "list is incomplete. Verify the `@/lib/extensions` side-effect import ran.",
    );
  }

  // Build a map of registry catalog entries by packageName so the Active tab
  // can still detect update-available state.
  const availableByName = new Map(
    available.map((entry) => [entry.packageName, entry]),
  );

  // Single batch SQL query replaces N per-row extensionHasBeenUsed calls. One
  // LEFT JOIN + GROUP BY returns which packageNames have ≥1 agent_run.
  const usedExtensions = await extensionHasBeenUsedBatch(
    activeTemplates.map((t) => t.packageName ?? ""),
  );

  const activeRowsWithVariant = activeTemplates.map((template) => {
    const used = usedExtensions.has(template.packageName ?? "");
    const destinationVariant: DestinationVariant = used ? "archive" : "remove";
    return { template, destinationVariant };
  });

  // Risk column data for BOTH tabs. Fast path: the `available` registry page
  // fetched above (riskLevel rides on every summary). Backfill: names that
  // page missed (q filter / row cap / viewer scope) resolve through a
  // packument-only read. Rows absent from the map render an em dash — see
  // registry-risk.ts for the full contract.
  const riskLevelByPackageName = await resolveRiskLevelsByPackageName({
    summaries: available,
    packageNames: [...activeTemplates, ...archivedTemplates].map(
      (template) => template.packageName,
    ),
    readPublishedSummary: (packageName) =>
      getPublishedExtensionSummary({ packageName }, verdaccioConfig),
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Extensions"
        description="Manage installed agents, skills, connectors, and artifacts."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        {/* Toolbar replaces tablist + section rule. Layout:
              <Select> (Active/Archived) · separator · "Marketplace"
              · "Upload" (with icon).
            The toolbar sits directly under the divider-suppressed
            PageHeader so no etched rule renders above. */}
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
                batches. */}
            <InstallBatchPanel batches={recentBatches} />
            {activeRowsWithVariant.length === 0 ? (
              <ActiveEmptyState />
            ) : (
              <div className="mt-4">
                <PaginatedTable>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Extension</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {activeRowsWithVariant.map(({ template, destinationVariant }) => {
                        const registryEntry = availableByName.get(
                          template.packageName ?? "",
                        );
                        const riskLevel = riskLevelByPackageName.get(
                          template.packageName ?? "",
                        );

                        // Detect update-available state by comparing installed vs registry version.
                        // If the registry has no entry for this package, treat as current.
                        const updateState = comparePluginVersions(
                          template.packageVersion,
                          registryEntry?.packageVersion ?? template.packageVersion ?? "",
                        );
                        const hasUpdate = updateState === "update-available";

                        const scopedMatch = /^@([^/]+)\/(.+)$/.exec(
                          template.packageName ?? "",
                        );
                        const detailHref: string | null = scopedMatch
                          ? `/configuration/marketplace/${scopedMatch[1]}/${scopedMatch[2]}`
                          : null;

                        // Bind the uninstall action with packageName + packageVersion.
                        const uninstallActionForRow: ((formData?: FormData) => void | Promise<void>) | null =
                          template.packageName
                            ? (uninstallExtensionPackageFormAction.bind(null, {
                                packageName: template.packageName,
                                packageVersion: template.packageVersion ?? "",
                              }) as unknown as (formData?: FormData) => void | Promise<void>)
                            : null;

                        return (
                          <TableRow
                            key={`${template.packageName}@${template.packageVersion}`}
                          >
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                {/* Name + VisibilityBadge render side-by-side. */}
                                <div className="flex items-center gap-2">
                                  <span className="font-semibold text-foreground">
                                    {detailHref ? (
                                      <Link
                                        href={detailHref}
                                        className="hover:underline"
                                      >
                                        {template.name}
                                      </Link>
                                    ) : (
                                      template.name
                                    )}
                                  </span>
                                  <VisibilityBadge
                                    visibility={template.origin?.visibility ?? "public"}
                                  />
                                </div>
                                <code className="text-xs text-muted-foreground font-mono">
                                  {template.packageName}
                                </code>
                                <div className="flex gap-2 mt-1 items-center">
                                  {hasUpdate && canUpdate && (
                                    <form
                                      action={updateExtensionPackageFormAction.bind(
                                        null,
                                        {
                                          packageName: template.packageName ?? "",
                                          packageVersion:
                                            registryEntry?.packageVersion ??
                                            template.packageVersion ??
                                            "",
                                        },
                                      )}
                                    >
                                      <Button
                                        type="submit"
                                        variant="outline"
                                        size="sm"
                                      >
                                        Update
                                      </Button>
                                    </form>
                                  )}
                                  {uninstallActionForRow && canUninstall && (
                                    <RegistryUninstallForm
                                      action={uninstallActionForRow}
                                      packageTitle={template.name ?? template.packageName ?? ""}
                                      destinationVariant={destinationVariant}
                                      variant="outline"
                                      size="sm"
                                      className="hover:text-destructive"
                                    />
                                  )}
                                  {/* Overflow menu with Promote / Demote actions. Only rendered for admins;
                                      non-admins see no menu. */}
                                  {isAdmin && (
                                    <ExtensionRowActions
                                      packageName={template.packageName ?? ""}
                                      packageVersion={template.packageVersion ?? ""}
                                      visibility={template.origin?.visibility ?? "public"}
                                    />
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal break-words">
                              <div className="flex flex-col gap-1">
                                <span className="text-sm text-foreground">
                                  {template.description ?? ""}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  v{template.packageVersion}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              {/* Same RiskBadge as the detail page's "Risk Level"
                                  field. Unresolved registry metadata renders a
                                  neutral placeholder, never a guessed level. */}
                              {riskLevel ? (
                                <RiskBadge riskLevel={riskLevel} />
                              ) : (
                                <span
                                  aria-label="Risk level unavailable"
                                  className="text-sm text-muted-foreground"
                                >
                                  —
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                </PaginatedTable>
              </div>
            )}
          </div>
        ) : (
          // ----------------------------------------------------------------
          // Archived body — archived extensions with Restore + Reinstall latest
          // ----------------------------------------------------------------
          <div>
            {archivedTemplates.length === 0 ? (
              <ArchivedEmptyState />
            ) : (
              <div>
                <PaginatedTable>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Extension</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>Risk</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {archivedTemplates.map((template: AgentTemplateRecord) => {
                        const riskLevel = riskLevelByPackageName.get(
                          template.packageName ?? "",
                        );
                        const scopedMatch = /^@([^/]+)\/(.+)$/.exec(
                          template.packageName ?? "",
                        );
                        const detailHref: string | null = scopedMatch
                          ? `/configuration/marketplace/${scopedMatch[1]}/${scopedMatch[2]}`
                          : null;

                        return (
                          <TableRow
                            key={`${template.packageName}@${template.packageVersion}`}
                          >
                            <TableCell>
                              <div className="flex flex-col gap-1">
                                <span className="font-semibold text-foreground">
                                  {detailHref ? (
                                    <Link
                                      href={detailHref}
                                      className="hover:underline"
                                    >
                                      {template.name}
                                    </Link>
                                  ) : (
                                    template.name
                                  )}
                                </span>
                                <code className="text-xs text-muted-foreground font-mono">
                                  {template.packageName}
                                </code>
                                {/* LifecycleBadge inline in archived rows. */}
                                <LifecycleBadge
                                  status="archived"
                                  className="w-fit mt-0.5"
                                />
                                <div className="flex gap-2 mt-1">
                                  <form
                                    action={restoreExtensionPackageFormAction.bind(
                                      null,
                                      { packageName: template.packageName ?? "" },
                                    )}
                                  >
                                    <Button
                                      type="submit"
                                      variant="outline"
                                      size="sm"
                                    >
                                      Restore ({template.packageVersion} pinned)
                                    </Button>
                                  </form>
                                  <form
                                    action={reinstallLatestFormAction.bind(null, {
                                      packageName: template.packageName ?? "",
                                    })}
                                  >
                                    <Button
                                      type="submit"
                                      variant="outline"
                                      size="sm"
                                    >
                                      Reinstall latest
                                    </Button>
                                  </form>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="whitespace-normal break-words">
                              <div className="flex flex-col gap-1">
                                <span className="text-sm text-foreground">
                                  {template.description ?? ""}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  v{template.packageVersion}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              {/* Same RiskBadge as the detail page's "Risk Level"
                                  field. Unresolved registry metadata renders a
                                  neutral placeholder, never a guessed level. */}
                              {riskLevel ? (
                                <RiskBadge riskLevel={riskLevel} />
                              ) : (
                                <span
                                  aria-label="Risk level unavailable"
                                  className="text-sm text-muted-foreground"
                                >
                                  —
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                </PaginatedTable>
              </div>
            )}
          </div>
        )}
      </PageContent>
    </Main>
  );
}
